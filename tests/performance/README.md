# Isolated browser performance and regression harness

<!-- 🍞 AI Breadcrumb Navigation — @COUPLED=implementation entry points.
@COUPLED tests/performance/browser.mjs, tests/performance/config.mjs,
tests/performance/isolation.mjs, tests/performance/fixtures.mjs,
tests/performance/metrics.mjs, tests/performance/scenarios.mjs,
tests/performance/diagnostics.mjs
-->

## Server-side probe / 服务端探针

```sh
node tests/performance/server-timing.mjs
SMALL=200 BIG=1460 node tests/performance/server-timing.mjs
```

The browser harness below mocks the WebSocket, so it cannot measure the server
half of "session switching feels slow". This probe starts an **isolated**
instance from TS source (`--import tsx`, no build) with its own agent dir, data
dir, workspace and a free port, seeds synthetic sessions with
`session-fixture.mjs`, and walks the two paths a browser walks:

1. `hello` → first `snapshot` (cold attach)
2. `list_sessions` → `switch_session` to the large fixture (disk switch)
3. switch back to the small fixture
4. a no-op switch (already active) — must still be answered with a snapshot

`PI_WEB_TIMING=1` makes `server/timing.ts` print one `[timing] …` line per path
(attach/switch phases, snapshot build time, wire bytes); the probe prints those
lines next to the measured wall-clock deltas. `session-fixture.mjs` generates
`N` messages in the SDK's on-disk JSONL shape, so history size is a parameter
instead of a fixed fixture.

Both files only ever write to a fresh temp directory: they never read or write a
real agent directory, and never touch a live instance.


Run from the repository root after the main build finishes:

```sh
node tests/performance/browser.mjs
```

The root npm integration should be `"test:performance": "node tests/performance/browser.mjs"`,
so the same entry runs through `npm run test:performance`. Package scripts and builds
are owned by the main integration task; this directory does not build or install anything.

`playwright-core` is resolved with `createRequire` from `vendor/pi-web-ui/package.json`.
Use an existing Chromium executable through `CHROME_PATH`, or let the harness discover
Playwright's installed executable/cache. No browser download occurs.

```sh
CHROME_PATH=/path/to/chrome BENCH_ITERATIONS=3 node tests/performance/browser.mjs
BENCH_WEB_ROOT=/path/to/baseline/dist BENCH_ASSERT=0 BENCH_ITERATIONS=3 node tests/performance/browser.mjs
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHROME_PATH` | Discover installed Chromium | Executable; invalid explicit paths fail |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default | Additional cache discovery location |
| `BENCH_WEB_ROOT` | `vendor/pi-web-ui/web/dist` | Built web root, including `index.html` and assets |
| `BENCH_ASSERT` | `1` | `0` records regressions without failing the exit status |
| `BENCH_ITERATIONS` | `1` | Positive integer; each iteration uses four fresh contexts |
| `BENCH_CPU` | `4` | CDP CPU slowdown multiplier, at least 1 |
| `BENCH_TIMEOUT_MS` | `180000 × iterations` | Hard Node deadline, including cleanup |
| `BENCH_STEP_TIMEOUT_MS` | `20000` | Each browser wait/navigation timeout |
| `BENCH_SETTLE_MS` | `300` | Observation interval after readiness/actions, plus two animation frames |
| `BENCH_MAX_ROWS` | `80` | Maximum mounted message rows at every measured chat phase |
| `BENCH_MAX_DOM` | `3500` | Maximum total document elements at every measured chat phase |

Default DOM budgets are constant across history sizes. They reject rendering all
200/1,000 rows, including cheap collapsed rows or one placeholder per message.
Question navigation is separately capped at 80 list entries and 100 rail ticks;
legacy placeholders are capped at the row budget, and aggregate spacers at six.
Use identical browser, CPU, viewport, iterations, and budgets for baseline/current comparisons.
Absolute timing budgets are intentionally omitted because host contention varies.

The four scenarios per iteration are:

- **Login:** wait for the Passkey gate; assert no App, markdown, xterm, terminal-panel,
  or plugin-view JS requests, and no chat WebSocket.
- **20 messages:** measure authenticated chat before selecting views; assert terminal
  and plugin code remains deferred. Select the local synthetic plugin and verify its
  mount, then select terminal and verify xterm is requested. No shell is started.
- **200 messages:** measure history startup with the same bounded DOM budgets.
- **1,000 messages:** measure startup, scroll to top, unfold an old collapsed message,
  scroll to bottom, search two old messages using next/previous, close search, jump
  via the first question-navigation tick, and use the return-to-bottom control.
  The search term occurs once in each of rows 0 and 2, beyond the collapsed preview.
  If the collapsed control is unavailable, the artifact explicitly records it as a
  failed check; other functional checks continue where possible.

Readiness waits for the **last** `.messages [data-msg-id]`, without assuming all
history rows exist. Navigation checks require the target row to intersect the
message scroller. The selectors intentionally depend on the public message IDs,
search controls, and existing navigation classes, rather than internal row wrappers.
Chunk checks use Vite's `App`, `markdown`, `xterm`, and `TerminalPanel` chunk names;
update `metrics.mjs` and `scenarios.mjs` if that build naming contract changes.

Every context is new and route-only at `http://pi-performance.test`. All HTTP
requests are fulfilled from an allowlist of files within the selected build root,
small locale/theme fixtures, or the synthetic plugin module. Unknown requests are
aborted. WebSockets are intercepted before navigation and never connect to a server.
The fake token exists only in this disposable context's localStorage. There is no
persistent profile, real session import, credential read, authentication request,
model invocation, or live API endpoint. Service workers are blocked. A dead loopback
proxy and disabled DNS/background networking provide additional browser isolation.
The browser's automation control transport is local.

The mock sends `ready`, plugin metadata, and the initial snapshot on `hello`;
it also answers `get_state` for baseline compatibility. Other outgoing WS message
types are counted, with a small set of read requests receiving empty fixture replies.
No outgoing WS payload is executed or forwarded, including terminal requests.

A timestamped JSON file is written under `.dev/performance/` and its absolute path
is printed. The harness checks that Git ignores the artifact before writing it.
Results include browser/configuration metadata, snapshot byte size, navigation-to-ready
and snapshot-to-ready time, DOM counts, heap estimate when available, and long-task
count/total/maximum/blocking time. Initial metrics include startup; later phases reset
the long-task accumulator and record action duration. Action duration includes the
configured settle interval. Timings are measurements of a mocked cold browser context,
not production network or server latency. Each iteration has a fresh context but shares
one browser process, so browser/process caches and OS file caches may remain warm.

Stdout and artifacts contain aggregate measurements, sanitized request paths, WS type
counts, and check names. They contain no full fixture text, request query strings, headers,
console logs, screenshots, traces, storage dumps, or full Playwright error dumps.
Browser page errors additionally retain up to three samples per context: a 500-character
first-line message and five stack frames of at most 240 characters each. URL queries are
removed. Samples include the active phase and timestamp, are printed immediately, and
trigger a partial artifact save so crashes can be diagnosed before later waits finish.
A failed step records its error class and bounded first-line message; later scenarios
still run. `BENCH_ASSERT=0`
relaxes regression checks only: external/unknown traffic, route failures, configuration
failures, and hard timeouts always fail. Partial results are saved after each scenario.
Contexts and browser close in `finally`; the hard deadline requests browser closure
and forces Node to exit after a two-second cleanup grace period if necessary.

Implementation validation includes `node --check` for all seven modules and a diagnostic
run against the earlier 05:58 integrated build. With the static-icon allowlist corrected,
login/20/200 passed; 1,000-message search reproduced React error 185 in that stale build.
The source owner subsequently reported the corrected source fixture passing; a rebuilt
integrated run is still required. Run after the main build includes those source fixes:

```sh
for file in tests/performance/*.mjs; do node --check "$file" || exit; done
npm run test:performance
```

This addition uses seven small ES modules and this README, with no new dependencies or
source/package changes. Generic self-check covers ESM resolution, isolation boundaries,
async cleanup, selector contracts, numeric settings, and file sizes. Project-specific
pipeline registration/trust checks do not apply because no pipeline configuration is present.

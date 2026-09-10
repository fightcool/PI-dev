/* 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @MAGIC=budget meaning.
 * @COUPLED tests/performance/scenarios.mjs, tests/performance/browser.mjs
 * @MAGIC 50ms is the browser long-task threshold; budgets are history-independent.
 * 📖 tests/performance/README.md
 */
export async function settle(page, milliseconds) {
  await page.waitForTimeout(milliseconds);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function measure(page) {
  return page.evaluate(() => {
    const metrics = window.__performanceHarness;
    const tasks = metrics.tasks;
    const durations = tasks.map(task => task.duration);
    return {
      elapsedMs: performance.now(),
      sinceSnapshotMs: metrics.snapshotAt === null ? null : performance.now() - metrics.snapshotAt,
      domNodes: document.querySelectorAll('*').length,
      messageRows: document.querySelectorAll('.messages [data-msg-id]').length,
      collapsedRows: document.querySelectorAll('.messages .msg-collapsed').length,
      placeholders: document.querySelectorAll('.msg-lazy-ph').length,
      spacers: document.querySelectorAll('.msg-window-spacer').length,
      questionEntries: document.querySelectorAll('.qn-list-item').length,
      questionTicks: document.querySelectorAll('.qn-bar').length,
      longTasks: { count: tasks.length, totalMs: durations.reduce((sum, value) => sum + value, 0),
        maxMs: Math.max(0, ...durations), blockingMs: durations.reduce((sum, value) => sum + Math.max(0, value - 50), 0) },
      heapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    };
  });
}

export function check(result, name, passed, details = {}) {
  result.checks.push({ name, passed: Boolean(passed), ...details });
}

export function bounded(result, phase, metrics, options) {
  check(result, `${phase}: bounded message DOM`, metrics.messageRows > 0 && metrics.messageRows <= options.maxRows,
    { actual: metrics.messageRows, max: options.maxRows });
  check(result, `${phase}: bounded total DOM`, metrics.domNodes <= options.maxDom,
    { actual: metrics.domNodes, max: options.maxDom });
  check(result, `${phase}: bounded placeholders and spacers`, metrics.placeholders <= options.maxRows && metrics.spacers <= 6,
    { placeholders: metrics.placeholders, spacers: metrics.spacers, maxPlaceholders: options.maxRows, maxSpacers: 6 });
  check(result, `${phase}: bounded question navigation`, metrics.questionEntries <= 80 && metrics.questionTicks <= 100,
    { entries: metrics.questionEntries, ticks: metrics.questionTicks, maxEntries: 80, maxTicks: 100 });
}

export function lazyChecks(result, traffic, login = false) {
  const paths = Object.keys(traffic.http);
  const js = paths.filter(path => /\.(?:m?js)$/.test(path));
  const terminal = js.filter(path => /\/(?:xterm|TerminalPanel)[-.]/i.test(path));
  const plugins = paths.filter(path => path.startsWith('/plugins/'));
  check(result, 'terminal code deferred before selection', terminal.length === 0, { requests: terminal.length });
  check(result, 'plugin view deferred before selection', plugins.length === 0, { requests: plugins.length });
  if (login) {
    const app = js.filter(path => /\/(?:App|markdown)[-.]/i.test(path));
    check(result, 'login does not fetch App or markdown', app.length === 0, { requests: app.length });
    check(result, 'login does not open WebSocket', Object.keys(traffic.ws).length === 0);
  }
}

export async function visibleMessage(page, id) {
  // A mounted virtual row can still be offscreen: verify overlap with the scroller.
  await page.waitForFunction(id => {
    const root = document.querySelector('.messages');
    const row = root?.querySelector(`[data-msg-id="${id}"]`);
    if (!root || !row) return false;
    const a = root.getBoundingClientRect(), b = row.getBoundingClientRect();
    return b.bottom > a.top + 1 && b.top < a.bottom - 1;
  }, id);
}

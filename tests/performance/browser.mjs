#!/usr/bin/env node
/* 🍞 AI Breadcrumb Navigation — @COUPLED=entry modules; @GOTCHA=cleanup contract.
 * @COUPLED tests/performance/config.mjs, tests/performance/isolation.mjs, tests/performance/scenarios.mjs
 * @GOTCHA Hard Node deadline remains armed during browser cleanup; output is aggregates only.
 * 📖 tests/performance/README.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, chromePath, root, vendorRequire } from './config.mjs';
import { snapshot } from './fixtures.mjs';
import { isolatedContext } from './isolation.mjs';
import { check } from './metrics.mjs';
import { scenario } from './scenarios.mjs';
import { errorSummary } from './diagnostics.mjs';

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const artifact = join(root, '.dev/performance', `${stamp}-${process.pid}.json`);
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version,
  status: 'running', results: [] };
let browser, hardStop, forceExit, canWrite = false, stage = 'configuration';
function save() {
  if (canWrite) writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n');
}
function emergency(reason) {
  report.status = 'failed';
  report.fatal = { stage, reason };
  try { save(); } catch { /* A write failure must not defeat the hard deadline. */ }
  console.error(`Performance harness ${reason}; artifact: ${artifact}`);
  forceExit ??= setTimeout(() => process.exit(1), 2000);
  void browser?.close().catch(() => {});
  process.exitCode = 1;
}
const signal = () => emergency('interrupted');
process.once('SIGINT', signal);
process.once('SIGTERM', signal);

try {
  // Enforce artifact hygiene without changing the repository's ignore rules.
  execFileSync('git', ['check-ignore', '-q', '--', artifact], { cwd: root, timeout: 5000, stdio: 'ignore' });
  mkdirSync(join(root, '.dev/performance'), { recursive: true });
  canWrite = true;
  const options = config();
  report.options = options;
  hardStop = setTimeout(() => emergency('hard-timeout'), options.timeout);
  stage = 'browser discovery';
  const { chromium } = vendorRequire('playwright-core');
  const executablePath = chromePath(chromium);
  report.chromePath = executablePath;
  save();
  stage = 'browser launch';
  browser = await chromium.launch({ executablePath, headless: true, timeout: options.stepTimeout,
    // Route fulfillment requires no HTTP listener. The dead proxy and DNS rule
    // also prevent accidental browser traffic outside Playwright routing.
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: ['--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--disable-sync', '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
  report.browserVersion = browser.version();
  for (let iteration = 1; iteration <= options.iterations; iteration++) {
    for (const count of [0, 20, 200, 1000]) {
      stage = count === 0 ? 'login' : `synthetic-${count}`;
      const state = count === 0 ? null : snapshot(count);
      const result = { scenario: stage, iteration, count, cpuSlowdown: options.cpu,
        snapshotBytes: state ? Buffer.byteLength(JSON.stringify(state)) : 0, checks: [], phases: {} };
      report.results.push(result);
      let context, traffic;
      try {
        ({ context, traffic } = await isolatedContext(browser, options, state, sample => {
          sample.phase = result.activePhase ?? 'setup';
          console.error(JSON.stringify({ event: 'synthetic-pageerror', scenario: result.scenario, ...sample }));
          save();
        }));
        result.traffic = traffic;
        context.setDefaultTimeout(options.stepTimeout);
        context.setDefaultNavigationTimeout(options.stepTimeout);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpu });
        await scenario(page, result, traffic, options, count);
      } catch (error) {
        check(result, 'scenario completes', false, { error: errorSummary(error) });
      } finally {
        await context?.close();
      }
      if (traffic) {
        check(result, 'zero page errors', traffic.pageErrors === 0, { count: traffic.pageErrors });
        result.isolationPassed = traffic.externalBlocked === 0 && traffic.unhandled === 0 && traffic.routeErrors === 0;
        check(result, 'all traffic fulfilled locally', result.isolationPassed);
      } else result.isolationPassed = false;
      result.passed = result.checks.every(item => item.passed);
      console.log(JSON.stringify({ scenario: result.scenario, iteration, passed: result.passed,
        readyMs: result.readyMs, domNodes: result.phases.initial?.domNodes,
        messageRows: result.phases.initial?.messageRows,
        failedChecks: result.checks.filter(item => !item.passed).map(item => item.name) }));
      save();
    }
  }
  const isolationFailed = report.results.some(result => !result.isolationPassed);
  const regressionFailed = report.results.some(result => !result.passed);
  const failed = Boolean(report.fatal) || isolationFailed || (options.assert && regressionFailed);
  report.status = failed ? 'failed' : regressionFailed ? 'measured-with-regressions' : 'passed';
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  report.status = 'failed';
  report.fatal = { stage, error: error.name, code: error.code ?? null };
  console.error(`Performance harness failed during ${stage} (${error.name}); see tests/performance/README.md`);
  process.exitCode = 1;
} finally {
  stage = 'browser cleanup';
  try { await browser?.close(); } catch { report.status = 'failed'; process.exitCode = 1; }
  clearTimeout(hardStop);
  clearTimeout(forceExit);
  process.removeListener('SIGINT', signal);
  process.removeListener('SIGTERM', signal);
  report.finishedAt = new Date().toISOString();
  try { save(); } catch { process.exitCode = 1; }
  if (canWrite) console.log(`Performance artifact: ${artifact}`);
  else console.error('Performance artifact unavailable: output directory must be Git-ignored and writable.');
}

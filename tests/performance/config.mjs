/* 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @WHY=design intent.
 * @COUPLED tests/performance/browser.mjs, tests/performance/isolation.mjs
 * @WHY Resolve dependencies from the vendor package without installing or downloading.
 * 📖 tests/performance/README.md
 */
import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const vendorRequire = createRequire(join(root, 'vendor/pi-web-ui/package.json'));
export const origin = 'http://pi-performance.test';

function number(name, fallback, minimum = 1, integer = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function config() {
  const iterations = number('BENCH_ITERATIONS', 1, 1, true);
  const webRoot = realpathSync(resolve(process.env.BENCH_WEB_ROOT ?? join(root, 'vendor/pi-web-ui/web/dist')));
  if (!existsSync(join(webRoot, 'index.html'))) throw new Error('BENCH_WEB_ROOT needs a built index.html');
  if (process.env.BENCH_ASSERT !== undefined && !['0', '1'].includes(process.env.BENCH_ASSERT)) {
    throw new Error('BENCH_ASSERT must be 0 or 1');
  }
  return {
    webRoot, iterations, assert: process.env.BENCH_ASSERT !== '0',
    cpu: number('BENCH_CPU', 4),
    timeout: number('BENCH_TIMEOUT_MS', 180000 * iterations),
    stepTimeout: number('BENCH_STEP_TIMEOUT_MS', 20000),
    settleMs: number('BENCH_SETTLE_MS', 300, 0),
    maxRows: number('BENCH_MAX_ROWS', 80, 1, true),
    maxDom: number('BENCH_MAX_DOM', 3500, 1, true),
  };
}

function executable(path) {
  try { accessSync(path, constants.X_OK); return path; } catch { return undefined; }
}

export function chromePath(chromium) {
  if (process.env.CHROME_PATH) {
    const selected = executable(resolve(process.env.CHROME_PATH));
    if (!selected) throw new Error('CHROME_PATH is not executable');
    return selected;
  }
  const bundled = executable(chromium.executablePath());
  if (bundled) return bundled;
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright'),
    join(homedir(), 'Library/Caches/ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  const layouts = ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-linux/headless_shell'];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const versions = readdirSync(cache).filter(name => /^chromium(?:_headless_shell)?-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const version of versions) for (const layout of layouts) {
      const found = executable(join(cache, version, layout));
      if (found) return found;
    }
  }
  throw new Error('No cached Chromium found; set CHROME_PATH to an installed browser');
}

/* 🍞 AI Breadcrumb Navigation — @COUPLED=implementation; @WHY=test scope.
 * @COUPLED dev-con/server.mjs, dev-con/overview.mjs, dev-con/web/app.js
 * @WHY Real browser + HTTP + collector contract, with fake service runner and synthetic password.
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { hashPassword } from '../dev-con/auth.mjs';
import { createControlServer } from '../dev-con/server.mjs';
import { createOverviewCollector } from '../dev-con/overview.mjs';
import { vendorRequire, chromePath, root } from './performance/config.mjs';

const { chromium } = vendorRequire('playwright-core');
let server, browser;
const deadline = setTimeout(() => { console.error('DEV-CON integration timed out'); process.exit(1); }, 45000);
try {
  const password = 'synthetic-integration-passphrase';
  server = createControlServer({ passwordHash: await hashPassword(password),
    collectOverview: createOverviewCollector({ run: async (_program, args) => ({ stdout:
      args.at(-1) === 'pi-dev-pm2.service' ? 'LoadState=loaded\nActiveState=active'
        : 'LoadState=not-found\nActiveState=inactive' }) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chromePath(chromium), headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(7000);
  const failures = [], blocked = [], violations = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push('unexpected external request');
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.name));
  page.on('console', message => { if (message.type() === 'error') violations.push('browser console error'); });
  await page.goto(origin);
  await page.waitForFunction(() => !document.querySelector('#password').disabled);
  await page.locator('#password').fill(password);
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('总览已更新'));
  assert.equal(await page.locator('#agent-rows tr').count(), 4);
  assert.equal(await page.locator('#service-rows tr').count(), 3);
  assert.match(await page.locator('#service-rows').textContent(), /pi-dev-pm2.service/);
  assert.equal(await page.locator('#password').inputValue(), '');
  const cookies = await context.cookies();
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, 'Strict');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const dir = join(root, '.dev/dev-con-artifacts');
  execFileSync('git', ['check-ignore', '-q', '--', join(dir, 'integration-desktop.png')], { cwd: root });
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, 'integration-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(dir, 'integration-mobile.png'), fullPage: true });
  await page.locator('#logout').click();
  await page.waitForFunction(() => document.querySelector('#feedback').textContent === '已注销。');
  assert.equal((await context.cookies()).length, 0);
  assert.equal(await page.locator('#agent-rows').textContent(), '');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#password').disabled);
  assert.equal(await page.locator('#workspace').isHidden(), true);
  assert.deepEqual(failures, []);
  assert.deepEqual(violations, []);
  assert.deepEqual(blocked, []);
  console.log('PASS real HTTP/browser login, overview, refresh, mobile layout, logout, cookie invalidation; synthetic service state only');
} catch (error) {
  console.error(`DEV-CON integration failed (${error.name}): ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  clearTimeout(deadline);
}

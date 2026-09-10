/* 🍞 AI Breadcrumb Navigation — @COUPLED=linked files; @WHY=design intent; 📖=design reference.
 * @COUPLED dev-con/web/index.html, dev-con/web/app.js, dev-con/web/style.css, tests/performance/config.mjs
 * 📖 docs/DEV-CON-IMPLEMENTATION.md (maintained by the coordinating agent)
 * @WHY Entire origin is mocked; no live server, model, or operator credentials are accessed.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { vendorRequire, chromePath, root } from './performance/config.mjs';
const { chromium } = vendorRequire('playwright-core');
const origin = 'http://dev-con.test';
const artifacts = join(root, '.dev/dev-con-artifacts');
let browser, context;
let cleaning;
function cleanup() {
  return cleaning ??= (async () => {
    try { await context?.close(); } finally { await browser?.close(); }
  })();
}
const deadline = setTimeout(() => {
  console.error('DEV-CON browser tests exceeded the 90s hard deadline');
  setTimeout(() => process.exit(1), 3000).unref();
  void browser?.close().catch(() => {});
  void cleanup().finally(() => process.exit(1));
}, 90000);
const errors = [], unexpected = [];
const fixture = {
  generatedAt: '2026-09-10T09:30:00.000Z',
  project: { name: 'PI-dev', version: '1.0.0', node: 'v22.0.0', uiVersion: '0.8.0', sdkVersion: '0.6.0' },
  host: { platform: 'linux', arch: 'x64', cpuCount: 8, loadAverage: [0, 0.12, 0.08],
    memoryTotalBytes: 17179869184, memoryFreeBytes: 8589934592, uptimeSeconds: 0 },
  services: [
    { id: 'ui', name: '开发 UI', manager: 'systemd', unit: 'pi-web-ui.service', status: 'active', detail: '管理单元处于活动状态。未执行应用健康检查。' },
    { id: 'console', name: 'DEV-CON', manager: 'systemd', unit: 'dev-con.service', status: 'inactive', detail: '管理单元未活动。' },
    { id: 'worker', name: '后台任务', manager: 'systemd', unit: 'worker.service', status: 'failed', detail: '管理单元报告失败。' },
  ],
  agents: [
    { id: 'pi', name: 'pi', availability: 'bundled', version: '0.6.0',
      capabilities: { inventory: 'available', channelSwitch: 'planned', skills: 'planned', mcp: 'planned' }, notes: '随仓库提供；此处不探测进程或模型连接。' },
    { id: 'other', name: '其他 Agent', availability: 'unverified', version: null,
      capabilities: { inventory: 'planned', channelSwitch: 'unsupported', skills: 'planned', mcp: 'planned' }, notes: '安装情况未核实。' },
  ],
};
let data = structuredClone(fixture), loggedIn = false, mode = 'ok', logoutFails = false;
let sessionToken = 'mock-csrf';
let overviewCalls = 0, loginCalls = 0, logoutCalls = 0;
const held = [];
const json = (route, status, value) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function visible(page, selector, state = 'visible') { await page.locator(selector).waitFor({ state }); }
async function text(page, selector, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent.includes(expected), { selector, expected });
}
async function login(page) {
  await page.locator('#password').fill('mock-only-password');
  await page.locator('#login-submit').click();
  await visible(page, '#workspace');
  await text(page, '#feedback', '总览已更新');
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page must not overflow horizontally');
}
try {
  execFileSync('git', ['check-ignore', '.dev/dev-con-artifacts/desktop.png', '.dev/dev-con-artifacts/mobile.png'], { cwd: root });
  await mkdir(artifacts, { recursive: true });
  const files = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(join(root, 'dev-con/web', name), 'utf8')])));
  for (const [name, source] of files) assert.ok(source.trimEnd().split('\n').length < 300, `${name} must stay below 300 lines`);
  browser = await chromium.launch({ executablePath: chromePath(chromium), headless: true,
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(6000);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin || url.search) { unexpected.push('unexpected origin or query'); return route.abort(); }
    const path = url.pathname;
    if (path === '/api/v1/auth/session') return json(route, 200, loggedIn ? { authenticated: true, csrfToken: sessionToken } : { authenticated: false });
    if (path === '/api/v1/auth/login') {
      loginCalls++;
      assert.equal(req.method(), 'POST');
      assert.equal(req.headers().origin, origin);
      loggedIn = req.postDataJSON().password === 'mock-only-password';
      return json(route, loggedIn ? 200 : 401, loggedIn ? { authenticated: true, csrfToken: sessionToken } : { error: 'invalid' });
    }
    if (path === '/api/v1/auth/logout') {
      logoutCalls++;
      assert.equal(req.method(), 'POST');
      assert.equal(req.headers()['x-csrf-token'], sessionToken);
      assert.equal(req.headers()['content-type'], 'application/json');
      assert.deepEqual(req.postDataJSON(), {});
      assert.equal(req.headers().origin, origin);
      if (logoutFails) return json(route, 503, { error: 'unavailable' });
      loggedIn = false;
      return json(route, 200, { authenticated: false });
    }
    if (path === '/api/v1/overview') {
      overviewCalls++;
      assert.equal(req.method(), 'GET');
      if (mode === 'hold') { held.push(route); return; }
      if (mode === '401' || !loggedIn) return json(route, 401, { error: 'unauthenticated' });
      if (mode === 'fail') return json(route, 503, { error: 'unavailable' });
      return json(route, 200, mode === 'malformed' ? {} : data);
    }
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!files.has(name)) { unexpected.push(path); return route.abort(); }
    return route.fulfill({ status: 200, body: files.get(name), headers: {
      'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css' : 'text/javascript',
      'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'",
    } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', e => window.__violations.push(e.violatedDirective));
  });
  await page.goto(origin);
  await page.locator('#password').waitFor();
  await page.waitForFunction(() => !document.querySelector('#password').disabled);
  assert.equal(overviewCalls, 0);
  await noOverflow(page);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#login-submit').evaluate(el => el.matches(':focus-visible')), true);
  assert.notEqual(await page.locator('#login-submit').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await page.locator('#password').fill('wrong-mock-password');
  await page.locator('#login-submit').click();
  await text(page, '#login-error', '密码不正确');
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.equal(await page.locator('#password').getAttribute('aria-invalid'), 'true');
  await login(page);
  assert.equal(loginCalls, 2);
  assert.equal(await page.locator('#password').inputValue(), '');
  await text(page, '#host-details', '0 小时');
  await text(page, '#agents-note', '不表示未安装');
  await text(page, '#services-note', '不代表应用可用性或模型健康');
  assert.equal(await page.locator('[style], script:not([src])').count(), 0);
  await noOverflow(page);
  await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('table').count(), 2);
  assert.equal(await page.getByRole('columnheader', { name: '核实情况' }).count(), 1);
  await noOverflow(page);
  await page.locator('nav a[href="#agents"]').click();
  assert.equal(new URL(page.url()).hash, '#agents');
  await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
  console.log('PASS login, semantics, keyboard focus, desktop and 390px screenshots');
  mode = 'hold';
  const before = overviewCalls;
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#refresh').disabled);
  await page.evaluate(() => document.querySelector('#refresh').dispatchEvent(new MouseEvent('click')));
  assert.equal(overviewCalls, before + 1);
  data.generatedAt = '2026-09-10T09:31:00.000Z';
  await json(held.shift(), 200, data);
  await text(page, '#snapshot', data.generatedAt);
  mode = 'fail';
  await page.locator('#refresh').click();
  await text(page, '#snapshot', '旧数据');
  await text(page, '#snapshot', data.generatedAt);
  await text(page, '#project-details', 'PI-dev');
  mode = 'malformed';
  await page.locator('#refresh').click();
  await text(page, '#feedback', '数据格式无效');
  await text(page, '#project-details', 'PI-dev');
  await page.clock.install();
  mode = 'hold';
  await page.locator('#refresh').click();
  await page.clock.runFor(10001);
  await text(page, '#feedback', '请求超时');
  await json(held.shift(), 200, data).catch(() => {});
  await page.clock.resume();
  console.log('PASS refresh, duplicate prevention, stale timestamps, malformed data, request timeout');
  // @WHY Ignore abort once to verify the generation guard independently of native fetch cancellation.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).endsWith('/overview')) {
        const response = await original(url, { ...options, signal: undefined });
        window.__lateDone = true;
        return response;
      }
      return original(url, options);
    };
  });
  await page.locator('#refresh').click();
  await page.locator('#logout').click();
  await text(page, '#feedback', '已注销。');
  await visible(page, '#workspace', 'hidden');
  assert.equal(await page.locator('#project-details').textContent(), '');
  await json(held.shift(), 200, data);
  await page.waitForFunction(() => window.__lateDone === true);
  await visible(page, '#workspace', 'hidden');
  assert.equal(await page.locator('#service-rows').textContent(), '');
  assert.equal(await page.locator('#password').inputValue(), '');
  mode = 'ok';
  await page.reload();
  await login(page);
  mode = '401';
  await page.locator('#refresh').click();
  await text(page, '#feedback', '登录已失效');
  await noOverflow(page);
  assert.equal(await page.getByLabel('控制台密码', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('#refresh').isDisabled(), false);
  assert.equal(await page.locator('#agent-rows').textContent(), '');
  console.log('PASS logout clears data, late response rejection, 401 returns to login');
  mode = 'ok';
  const attack = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  data.project.name = attack;
  data.services[0].name = attack;
  data.services[0].detail = attack + '长文本'.repeat(100);
  data.services[0].status = '__proto__';
  data.agents[0].name = attack;
  data.agents[0].notes = attack;
  await login(page);
  await text(page, '#project-details', attack);
  assert.equal(await page.locator('#data img, #data script').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await text(page, '#service-rows', '未知');
  await noOverflow(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await noOverflow(page);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(await page.evaluate(() => window.__violations), []);
  // Another tab logged in: the cookie now belongs to a different CSRF session.
  sessionToken = 'rotated-csrf';
  logoutFails = true;
  await page.locator('#logout').click();
  await text(page, '#feedback', '服务器注销尚未确认');
  assert.equal(await page.locator('#project-details').textContent(), '');
  logoutFails = false;
  await page.locator('#logout').click();
  await text(page, '#feedback', '已注销。');
  data = structuredClone(fixture);
  loggedIn = true;
  await page.reload();
  await text(page, '#feedback', '总览已更新');
  data.services = []; data.agents = [];
  await page.locator('#refresh').click();
  await text(page, '#service-rows', '暂无服务记录');
  await text(page, '#agent-rows', '暂无 Agent 记录');
  assert.equal(logoutCalls, 3);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log('PASS inert malicious text, no storage, CSP, rotated-session logout retry, restored session and empty states');
  console.log('DEV-CON browser tests passed; screenshots: .dev/dev-con-artifacts/{desktop,mobile}.png');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  clearTimeout(deadline);
}

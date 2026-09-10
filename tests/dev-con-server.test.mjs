/* 🍞 AI Breadcrumb: @COUPLED=linked files.
 * @COUPLED dev-con/server.mjs, dev-con/auth.mjs; 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { hashPassword } from '../dev-con/auth.mjs';
import { createControlServer } from '../dev-con/server.mjs';

const password = 'local-test-console-password';
const passwordHash = await hashPassword(password);
async function fixture(t, options = {}) {
  const server = createControlServer({ passwordHash, collectOverview: async () => ({ ok: true }), ...options });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  async function request(path, { method = 'GET', headers = {}, data } = {}) {
    return new Promise((resolve, reject) => {
      const body = typeof data === 'string' ? data : data === undefined ? undefined : JSON.stringify(data);
      const req = http.request({ host: '127.0.0.1', port, path, method,
        headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        let text = '';
        res.setEncoding('utf8').on('data', chunk => { text += chunk; });
        res.on('error', reject).on('end', () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode, headers: res.headers, text,
            json: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : undefined });
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error('Request deadline')), 3000);
      req.on('error', error => { clearTimeout(deadline); reject(error); });
      req.end(body);
    });
  }
  const login = async () => {
    const response = await request('/api/v1/auth/login', { method: 'POST', data: { password },
      headers: options.origin ? { Host: new URL(options.origin).host, Origin: options.origin } : {} });
    assert.equal(response.status, 200);
    return { cookie: response.headers['set-cookie'][0].split(';')[0], token: response.json.csrfToken, response };
  };
  return { server, request, login, origin };
}

test('authentication gates collector; session, CSRF, rotation and logout form a closed loop', { timeout: 10000 }, async t => {
  let calls = 0;
  const { request, login } = await fixture(t, { collectOverview: async () => { calls++; return { value: 17 }; } });
  assert.deepEqual((await request('/api/v1/auth/session')).json, { authenticated: false });
  assert.equal((await request('/api/v1/overview')).status, 401);
  assert.equal(calls, 0);
  const failed = await request('/api/v1/auth/login', { method: 'POST', data: { password: 'wrong-test-password' } });
  assert.equal(failed.status, 401);
  assert.equal(failed.text, '{"error":"Authentication failed"}');
  const { cookie, token, response } = await login();
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
  assert.equal((await request('/api/v1/auth/session', { headers: { Cookie: cookie } })).json.csrfToken, token);
  assert.deepEqual((await request('/api/v1/overview', { headers: { Cookie: cookie } })).json, { value: 17 });
  assert.equal(calls, 1);
  assert.equal((await request('/api/v1/auth/logout', { method: 'POST', data: {}, headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request('/api/v1/auth/logout', { method: 'POST', data: {}, headers: { Cookie: cookie, 'x-csrf-token': 'wrong' } })).status, 403);
  const logout = await request('/api/v1/auth/logout', { method: 'POST', data: {}, headers: { Cookie: cookie, 'x-csrf-token': token } });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.json, { authenticated: false });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request('/api/v1/overview', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request('/api/v1/auth/logout', { method: 'POST', data: {}, headers: { Cookie: cookie, 'x-csrf-token': token } })).status, 401);
  const renewed = await login();
  const rotated = await request('/api/v1/auth/login', { method: 'POST', data: { password }, headers: { Cookie: renewed.cookie } });
  assert.equal(rotated.status, 200);
  assert.deepEqual((await request('/api/v1/auth/session', { headers: { Cookie: renewed.cookie } })).json, { authenticated: false });
});

test('Host/Origin binding ignores forwarded headers and requires JSON', { timeout: 10000 }, async t => {
  const { request, origin } = await fixture(t);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'http://evil.example' },
    { Host: 'evil.example', 'X-Forwarded-Host': new URL(origin).host, 'X-Forwarded-Proto': 'http' },
    { Origin: 'null' }]) {
    assert.equal((await request('/api/v1/auth/session', { headers })).status, 403);
  }
  for (const headers of [{ Origin: '' }, { Origin: 'http://evil.example' }]) {
    assert.equal((await request('/api/v1/auth/login', { method: 'POST', data: { password }, headers })).status, 403);
  }
  assert.equal((await request('/api/v1/auth/login', { method: 'POST', data: { password }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/v1/auth/session', { headers: { 'X-Forwarded-Host': 'evil.example' } })).status, 200);
});

test('configured HTTPS origin binds host and creates Secure cookies', { timeout: 10000 }, async t => {
  const { request, login } = await fixture(t, { origin: 'https://console.example' });
  assert.equal((await request('/api/v1/auth/session')).status, 403);
  const { response } = await login();
  assert.match(response.headers['set-cookie'][0], /; Secure$/);
});

test('exact static allowlist prevents source, config, and traversal disclosure; security headers apply', { timeout: 10000 }, async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/app.js', '/style.css']) {
    const result = await request(path);
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['x-frame-options'], 'DENY');
    assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(result.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  }
  for (const path of ['/auth.mjs', '/config.json', '/.env', '/../cli.mjs', '/%2e%2e/cli.mjs', '/app.js?x=1', '/web/index.html', '/api/v1/overview?x=1']) {
    const result = await request(path);
    assert.equal(result.status, 404);
    assert.equal(result.text, '{"error":"Not found"}');
    assert.equal(result.headers['cache-control'], 'no-store');
  }
});

test('oversize and malformed bodies, collector failures, and rate limits are bounded and generic', { timeout: 10000 }, async t => {
  const { request, login, server } = await fixture(t, { collectOverview: async () => { throw new Error('private-test-detail'); } });
  for (const data of ['{', 'null', '[]']) {
    assert.equal((await request('/api/v1/auth/login', { method: 'POST', data })).status, 400);
  }
  assert.equal((await request('/api/v1/auth/login', { method: 'POST', data: 'a'.repeat(16385) })).status, 413);
  const { cookie } = await login();
  const failed = await request('/api/v1/overview', { headers: { Cookie: cookie } });
  assert.equal(failed.status, 500);
  assert.equal(failed.text, '{"error":"Request failed"}');
  assert.equal(failed.headers['cache-control'], 'no-store');
  for (let i = 0; i < 9; i++) assert.equal((await request('/api/v1/auth/login', { method: 'POST', data: {} })).status, 401);
  const limited = await request('/api/v1/auth/login', { method: 'POST', data: { password } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 10000);
  assert.ok(server.headersTimeout > 0 && server.keepAliveTimeout > 0);
});

test('factory requires collector and rejects non-loopback listener and invalid origins', () => {
  assert.throws(() => createControlServer({ passwordHash }));
  for (const origin of ['http://user:pass@example.com', 'https://example.com/path', 'https://example.com/', 'ftp://example.com']) {
    assert.throws(() => createControlServer({ passwordHash, collectOverview() {}, origin }));
  }
  const server = createControlServer({ passwordHash, collectOverview() {} });
  assert.throws(() => server.listen(0, '0.0.0.0'));
  assert.throws(() => server.listen({ path: '/tmp/dev-con-test.sock' }));
});

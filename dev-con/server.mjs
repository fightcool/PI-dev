/* 🍞 AI Breadcrumb: @COUPLED=linked files; @WHY=design reason.
 * @COUPLED dev-con/auth.mjs, dev-con/cli.mjs, dev-con/web/app.js, tests/dev-con-server.test.mjs
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAuth, equalToken, SESSION_SECONDS } from './auth.mjs';

const COOKIE = 'dev_con_session';
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const BODY_LIMIT = 16 * 1024;

export function validateOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || url.origin !== value) {
    throw new Error('Invalid origin');
  }
  return url;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(408), 5000);
    function finish(status, value) {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      if (status) { req.resume(); reject(Object.assign(new Error('Invalid request'), { status })); }
      else resolve(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > BODY_LIMIT) finish(413);
      else chunks.push(chunk);
    }
    function onError() { finish(400); }
    function onEnd() {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(400);
        finish(0, value);
      } catch { finish(400); }
    }
    req.on('data', onData).on('end', onEnd).on('error', onError).on('aborted', onError);
    if (Number(req.headers['content-length']) > BODY_LIMIT) finish(413);
  });
}

function sessionId(req) {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function createControlServer({ passwordHash, collectOverview, origin } = {}) {
  if (typeof collectOverview !== 'function') throw new Error('Overview collector required');
  const fixedOrigin = origin === undefined ? undefined : validateOrigin(origin);
  const auth = createAuth(passwordHash);
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    req.on('error', () => {}); // Late aborted-body errors must not escape the request boundary.
    handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: 'Request failed' });
      else res.destroy();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(10000, socket => socket.destroy());
  server.maxRequestsPerSocket = 100;
  server.on('close', () => auth.clear());
  // @WHY Even callers using the factory cannot accidentally expose the listener.
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    if (!options || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
        || options.path || options.fd !== undefined || options.handle
        || (options.host !== undefined && options.host !== '127.0.0.1')) throw new Error('Loopback listener required');
    const callback = args.find(arg => typeof arg === 'function');
    return listen({ port: options.port, host: '127.0.0.1' }, callback);
  };

  async function handle(req, res) {
    const expected = fixedOrigin ?? new URL(`http://127.0.0.1:${server.address().port}`);
    const suppliedOrigin = req.headers.origin;
    if (req.headers.host !== expected.host || (suppliedOrigin !== undefined && suppliedOrigin !== expected.origin)
        || (req.method === 'POST' && suppliedOrigin !== expected.origin)) {
      return json(res, 403, { error: 'Request denied' });
    }
    if (req.method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'JSON required' });
    }
    const id = sessionId(req);
    const session = auth.get(id);
    const route = `${req.method} ${req.url}`;
    const cookie = (value, age) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${expected.protocol === 'https:' ? '; Secure' : ''}`;
    if (route === 'GET /api/v1/auth/session') {
      return json(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false });
    }
    if (route === 'POST /api/v1/auth/login' || route === 'POST /api/v1/auth/logout') {
      let input;
      try { input = await body(req); } catch (error) {
        res.setHeader('Connection', 'close');
        return json(res, error.status ?? 400, { error: 'Invalid request' });
      }
      if (route.endsWith('/login')) {
        const result = await auth.login(input.password, id);
        if (result.status !== 200) {
          if (result.status === 429) res.setHeader('Retry-After', '60');
          return json(res, result.status, { error: 'Authentication failed' });
        }
        res.setHeader('Set-Cookie', cookie(result.id, SESSION_SECONDS));
        return json(res, 200, { authenticated: true, csrfToken: result.csrfToken });
      }
      if (!session) return json(res, 401, { error: 'Authentication required' });
      if (!equalToken(req.headers['x-csrf-token'], session.csrfToken)) {
        return json(res, 403, { error: 'Request denied' });
      }
      auth.remove(id);
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, { authenticated: false });
    }
    if (route === 'GET /api/v1/overview') {
      if (!session) return json(res, 401, { error: 'Authentication required' });
      return json(res, 200, await collectOverview());
    }
    const asset = req.method === 'GET' ? STATIC.get(req.url) : undefined;
    if (!asset) return json(res, 404, { error: 'Not found' });
    const content = await readFile(new URL(`./web/${asset[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': asset[1] });
    res.end(content);
  }
  return server;
}

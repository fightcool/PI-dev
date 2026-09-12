/* 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @GOTCHA=isolation boundary.
 * @COUPLED tests/performance/config.mjs, tests/performance/fixtures.mjs, tests/performance/browser.mjs
 * @GOTCHA Never call route.continue(), route.fetch(), or socket.connectToServer().
 * 📖 tests/performance/README.md
 */
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { origin } from './config.mjs';
import { pluginId, pluginModule, socketReply } from './fixtures.mjs';
import { errorSummary } from './diagnostics.mjs';

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/**
 * @param onPageError page 内异常回调（性能报告用）
 * @param onClientMessage 客户端发出的每一帧（可选；供功能型浏览器用例断言实际发出的命令）。
 *        ⚠️ 不要在调用方再注册 context.routeWebSocket —— 那会替换掉这里的替身 socket，
 *        导致 hello 之后收不到任何服务端消息。要观察客户端帧就用这个回调。
 */
export async function isolatedContext(browser, options, state, onPageError = () => {}, onClientMessage = () => {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
    locale: 'en-US', serviceWorkers: 'block', acceptDownloads: false });
  const traffic = { http: {}, ws: {}, assetBytes: 0, assetRequests: 0,
    externalBlocked: 0, unhandled: 0, routeErrors: 0, pageErrors: 0, pageErrorSamples: [] };
  try {
    // Catch ALL URLs, including unexpected hosts; no request reaches a real server.
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          traffic.externalBlocked++;
          await route.abort('blockedbyclient');
          return;
        }
        const path = decodeURIComponent(url.pathname);
        // Store no query strings, headers, payloads, or error messages in artifacts.
        const category = path.startsWith('/assets/') ? path : path.startsWith('/plugins/') ? '/plugins/fixture' : path;
        increment(traffic.http, category);
        if (route.request().method() !== 'GET') {
          traffic.unhandled++;
          await route.abort('blockedbyclient');
          return;
        }
        if (path === '/api/locales' || path === '/api/themes') {
          await route.fulfill({ json: path.endsWith('locales') ? { packs: [] } : { themes: [] } });
          return;
        }
        if (path === `/plugins/${pluginId}/client/entry.mjs`) {
          await route.fulfill({ contentType: 'application/javascript', body: pluginModule });
          return;
        }
        const relative = path === '/' ? 'index.html' : path.slice(1);
        const allowed = path === '/' || /^\/assets\/[A-Za-z0-9_./-]+$/.test(path) ||
          /^\/(?:favicon\.(?:ico|svg)|manifest\.webmanifest|manifest\.json|(?:icons\/)?[A-Za-z0-9_-]+\.png)$/.test(path);
        if (!allowed || !mime[extname(relative)]) {
          traffic.unhandled++;
          await route.abort('blockedbyclient');
          return;
        }
        const file = await realpath(resolve(options.webRoot, relative));
        if (!file.startsWith(options.webRoot + sep)) throw new Error('Asset outside build');
        const body = await readFile(file);
        traffic.assetRequests++;
        traffic.assetBytes += body.byteLength;
        await route.fulfill({ contentType: mime[extname(file)], body });
      } catch {
        traffic.routeErrors++;
        await route.abort('failed').catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.origin !== origin.replace('http:', 'ws:') || url.pathname !== '/ws' || !state) {
        traffic.externalBlocked++;
        socket.close();
        return;
      }
      socket.onMessage(raw => {
        try {
          const message = JSON.parse(String(raw));
          const type = typeof message.type === 'string' && /^[a-z_]{1,60}$/.test(message.type) ? message.type : 'invalid';
          increment(traffic.ws, type);
          onClientMessage(message);
          for (const reply of socketReply(message, state)) socket.send(JSON.stringify(reply));
        } catch { traffic.routeErrors++; }
      });
    });
    await context.addInitScript(({ authenticated, expectedOrigin }) => {
      if (location.origin !== expectedOrigin) return;
      if (authenticated) localStorage.setItem('pi-web-ui:token', 'synthetic-fixture-only');
      localStorage.setItem('pi-web-ui:lang', 'en');
      localStorage.setItem('pi-web-ui:left-panel-collapsed', '1');
      localStorage.setItem('pi-web-ui:right-panel-collapsed', '1');
      const metrics = { tasks: [], snapshotAt: null };
      window.__performanceHarness = metrics;
      new PerformanceObserver(list => {
        for (const task of list.getEntries()) metrics.tasks.push({ start: task.startTime, duration: task.duration });
      }).observe({ type: 'longtask', buffered: true });
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            try {
              if (JSON.parse(event.data).type === 'snapshot' && metrics.snapshotAt === null) metrics.snapshotAt = performance.now();
            } catch { /* Only the fixture's snapshot timing matters. */ }
          });
        }
      };
    }, { authenticated: Boolean(state), expectedOrigin: origin });
    context.on('page', page => page.on('pageerror', error => {
      traffic.pageErrors++;
      if (traffic.pageErrorSamples.length >= 3) return;
      const sample = { ...errorSummary(error, true), at: new Date().toISOString() };
      traffic.pageErrorSamples.push(sample);
      onPageError(sample);
    }));
    return { context, traffic };
  } catch (error) {
    await context.close();
    throw error;
  }
}

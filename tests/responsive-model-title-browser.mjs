#!/usr/bin/env node
/* 🍞 @COUPLED vendor/pi-web-ui/web/src/app/use-app-effects.ts,
 * vendor/pi-web-ui/web/src/components/ModelThinking.tsx, tests/performance/isolation.mjs
 * @CONTRACT Desktop/mobile consume identical server model lists and conversation updates.
 * Synthetic WS only; backend filtering is covered by settings synchronization tests.
 */
import assert from 'node:assert/strict';
import { config, chromePath, origin, vendorRequire } from './performance/config.mjs';
import { isolatedContext } from './performance/isolation.mjs';
import { snapshot, socketReply } from './performance/fixtures.mjs';

const { chromium } = vendorRequire('playwright-core');
const options = config();
const deadline = setTimeout(() => process.exit(1), 120_000);
let browser;
try {
  browser = await chromium.launch({ executablePath: chromePath(chromium), headless: true,
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const models = ['alpha', 'beta'].map(id => ({ id: `gateway/${id}`, name: id, provider: 'gateway', vision: false }));
    const state = { ...snapshot(1), models, model: { ...models[0], id: 'alpha' } };
    const { context, traffic } = await isolatedContext(browser, options, state);
    try {
      let socket;
      const sent = [];
      const conversations = [
        { id: 'assessment', title: '当前会话', cwd: '/synthetic', messageCount: 1, isStreaming: false, isSubagent: false },
        { id: 'second', title: '另一个会话', cwd: '/synthetic', messageCount: 0, isStreaming: false, isSubagent: false },
      ];
      const listedConversations = conversations.filter(conversation => conversation.id !== 'assessment');
      await context.routeWebSocket('**/*', ws => {
        assert.equal(new URL(ws.url()).origin, origin.replace('http:', 'ws:'));
        socket = ws;
        ws.onMessage(raw => {
          const message = JSON.parse(String(raw));
          sent.push(message);
          const replies = message.type === 'list_conversations'
            ? [{ type: 'conversations', conversations: listedConversations, activeId: 'assessment', activeTitle: '当前会话' }]
            : socketReply(message, state);
          for (const reply of replies) ws.send(JSON.stringify(reply));
          if (message.type === 'hello') {
            ws.send(JSON.stringify({
              type: 'conversations',
              conversations: listedConversations,
              activeId: 'assessment',
              activeTitle: '当前会话',
            }));
          }
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.setViewportSize(viewport);
      await page.goto(origin);
      await page.waitForFunction(() => document.title === '白衣Dev + 当前会话');
      socket.send(JSON.stringify({
        type: 'conversations',
        conversations,
        activeId: 'second',
        activeTitle: '另一个会话',
      }));
      await page.waitForFunction(() => document.title === '白衣Dev + 另一个会话');
      conversations[1].title = '重命名后的会话';
      socket.send(JSON.stringify({
        type: 'conversations',
        conversations,
        activeId: 'second',
        activeTitle: '重命名后的会话',
      }));
      await page.waitForFunction(() => document.title === '白衣Dev + 重命名后的会话');
      socket.send(JSON.stringify({ type: 'conversations', conversations: [], activeId: '' }));
      await page.waitForFunction(() => document.title === '白衣Dev');

      await page.locator('.composer-tools .chip').filter({ has: page.locator('.chip-model') }).click();
      const menu = page.locator('.dd-menu-model');
      await menu.waitFor({ state: 'visible' });
      assert.deepEqual(await menu.locator('.dd-model-name').allTextContents(), ['alpha', 'beta']);
      assert.equal(await menu.locator('.dd-item.active .dd-model-name').textContent(), 'alpha');
      // Simulate a server push after another device changes the configured list.
      state.models = [models[1]];
      socket.send(JSON.stringify({ type: 'models', models: state.models }));
      await page.waitForFunction(() => document.querySelectorAll('.dd-menu-model .dd-model-name').length === 1);
      assert.deepEqual(await menu.locator('.dd-model-name').allTextContents(), ['beta']);
      await menu.locator('.dd-item').click();
      assert.ok(sent.some(message => message.type === 'set_model' && message.modelId === 'gateway/beta'));
      assert.equal(traffic.pageErrors, 0);
      assert.equal(traffic.externalBlocked + traffic.unhandled + traffic.routeErrors, 0);
      console.log(`PASS ${viewport.width}px: title follows selection/rename; model list follows configured-list pushes and selects the correct ID`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  clearTimeout(deadline);
}

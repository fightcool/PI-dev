/* 🍞 AI Breadcrumb Navigation — @COUPLED=fixtures and DOM owners; @CONTRACT=selectors.
 * @COUPLED tests/performance/fixtures.mjs, tests/performance/metrics.mjs
 * @COUPLED vendor/pi-web-ui/web/src/components/MessageList.tsx, vendor/pi-web-ui/web/src/components/SearchBar.tsx
 * @CONTRACT Readiness waits for the LAST data-msg-id, never a history-wide row count.
 * 📖 tests/performance/README.md
 */
import { origin } from './config.mjs';
import { messageId, searchTerm } from './fixtures.mjs';
import { bounded, check, lazyChecks, measure, settle, visibleMessage } from './metrics.mjs';
import { errorSummary } from './diagnostics.mjs';

async function phase(page, result, options, name, action) {
  result.activePhase = name;
  try {
    const started = await page.evaluate(() => {
      window.__performanceHarness.tasks = [];
      return performance.now();
    });
    await action();
    await settle(page, options.settleMs);
    const metrics = await measure(page);
    result.phases[name] = { ...metrics, actionMs: metrics.elapsedMs - started };
    check(result, `${name}: functional`, true);
    bounded(result, name, metrics, options);
  } catch (error) {
    // Playwright errors may contain full row labels: retain only a bounded first line.
    check(result, `${name}: functional`, false, { error: errorSummary(error) });
  }
}

async function scrollTo(page, count, end) {
  await page.locator('.messages').evaluate((root, end) => {
    root.scrollTop = end ? root.scrollHeight : 0;
    root.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, end);
  await visibleMessage(page, messageId(end ? count - 1 : 0));
}

/**
 * 尾部优先历史（P1-8）：大历史首屏只带最近若干条，滚到顶部会自动补一页。
 * 补页会做**视口锚定**（保持你正在看的内容不动），所以「滚到顶 → 立刻断言最老一条可见」
 * 已经不成立：先等补页完成（「载入更早」入口消失），再滚一次顶，才到真正的历史开头。
 */
async function loadEarlierIfPresent(page) {
  if (await page.locator('.msg-older-btn').count() === 0) return false;
  // 不用真正「点击」：mock 在同一 tick 回包，元素会在点击动作进行中被卸载（Playwright
  // 会一直重试到超时）。走的是同一个真实路径——滚到顶部后 onScroll 自动请求上一页。
  await page.waitForFunction(() => document.querySelectorAll('.msg-older-btn').length === 0, null, { timeout: 5000 });
  return true;
}

async function historyActions(page, result, options, count) {
  // 第一步：滚到顶。大历史会在这里自动补一页（锚定视口，所以此刻还不能断言最老一条可见）。
  await phase(page, result, options, 'scrollTop', async () => {
    await page.locator('.messages').evaluate((root) => {
      root.scrollTop = 0;
      root.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    result.tailFirst = (await loadEarlierIfPresent(page)) ? 'loaded-earlier' : 'complete-snapshot';
  });
  // 第二步：历史已补全，再滚一次顶就能看到真正的最老一条。
  await phase(page, result, options, 'scrollTopOldest', () => scrollTo(page, count, false));
  await phase(page, result, options, 'unfoldOld', async () => {
    const folded = page.locator(`.msg-collapsed[data-msg-id="${messageId(1)}"]`);
    if (await folded.count() === 0) {
      result.unfold = 'unavailable: old row has no collapsed control';
      check(result, 'old history offers collapsed unfold', false);
      return;
    }
    await folded.click();
    await page.waitForFunction(id => {
      const row = document.querySelector(`.messages [data-msg-id="${id}"]`);
      return row && !row.classList.contains('msg-collapsed') && row.textContent.length > 500;
    }, messageId(1));
    result.unfold = 'expanded';
  });
  await phase(page, result, options, 'scrollBottom', () => scrollTo(page, count, true));
  await phase(page, result, options, 'searchOld', async () => {
    await page.locator('.messages').evaluate(root => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      root.focus();
    });
    await page.keyboard.press('Control+f');
    await page.locator('.search-bar input').fill(searchTerm);
    await page.waitForFunction(() => document.querySelector('.search-count')?.textContent?.trim() === '1/2');
    await visibleMessage(page, messageId(0));
  });
  await phase(page, result, options, 'searchNextOld', async () => {
    await page.locator('.search-bar input').press('Enter');
    await page.waitForFunction(() => document.querySelector('.search-count')?.textContent?.trim() === '2/2');
    await visibleMessage(page, messageId(2));
  });
  await phase(page, result, options, 'searchPreviousOld', async () => {
    await page.locator('.search-bar input').press('Shift+Enter');
    await page.waitForFunction(() => document.querySelector('.search-count')?.textContent?.trim() === '1/2');
    await visibleMessage(page, messageId(0));
    await page.keyboard.press('Escape');
    await page.locator('.search-bar').waitFor({ state: 'hidden' });
  });
  await phase(page, result, options, 'jumpOld', async () => {
    await scrollTo(page, count, true);
    // The first rail tick exists in both the old and windowed question navigation.
    await page.locator('.qn-bar').first().click();
    await visibleMessage(page, messageId(0));
  });
  await phase(page, result, options, 'backToBottom', async () => {
    await page.locator('.scroll-bottom').click();
    await visibleMessage(page, messageId(count - 1));
  });
}

async function selectViews(page, result, traffic, options) {
  result.activePhase = 'selectViews';
  try {
    await page.getByRole('tab', { name: 'Performance Fixture', exact: true }).click();
    await page.locator('[data-performance-plugin="ready"]').waitFor();
    check(result, 'selected plugin mounts local fixture', true);
    const alreadyLoaded = Object.keys(traffic.http).some(path => /\/xterm[-.].*\.js$/.test(path));
    if (alreadyLoaded) {
      // A baseline may have eagerly loaded xterm; the earlier deferred check records that regression.
      await page.getByRole('tab', { name: /terminal|终端/i }).click();
    } else {
      const xterm = page.waitForResponse(response => /\/xterm[-.].*\.js$/.test(new URL(response.url()).pathname));
      await Promise.all([xterm, page.getByRole('tab', { name: /terminal|终端/i }).click()]);
    }
    await settle(page, options.settleMs);
    check(result, 'selected terminal fetches xterm', Object.keys(traffic.http).some(path => /\/xterm[-.].*\.js$/.test(path)));
  } catch (error) {
    check(result, 'selected views load on demand', false, { error: errorSummary(error) });
  }
}

/**
 * 底部控件自动收缩（web/src/chrome-collapse.ts）：在真实浏览器里验证「往上翻 → 收起，
 * 滑回最底部 → 展开」，收起时输入框仍可用（能打字、能发送），以及**状态栏不参与收起**
 * （它显示即时监控：上下文占用与缓存命中率，收起等于把仪表盘关掉）。
 * @WHY 这条规则影响目标条与输入工具条两处，必须在真实滚动事件与真实布局下验证；
 *   纯函数单测只能钉住判定，不能证明 DOM 真的收起来了。
 */
async function chromeCollapseChecks(page, result, options) {
  result.activePhase = 'chromeCollapse';
  let chromeStep = 'start';
  /** 等输入工具条达到期望的收起状态（React 提交 + 上报在下几个帧内完成，不靠固定 sleep）。 */
  const waitCollapsed = want =>
    page.waitForFunction(
      expected => document.querySelector('.inputbar')?.classList.contains('chrome-collapsed') === expected,
      want,
      { timeout: 5000 },
    );
  try {
    const collapsed = () => page.locator('.inputbar.chrome-collapsed').count();
    chromeStep = 'baseline';
    // 起点：停在最底部（上一个阶段刚点过「回到底部」）→ 不收起。
    check(result, 'chrome expands while pinned to the bottom', (await collapsed()) === 0);
    check(
      result,
      'status bar shows live metrics while expanded',
      (await page.locator('.statusbar .status-cache').isVisible()) && (await page.locator('.statusbar .status-ctx').isVisible()),
    );
    // 往上翻历史 → 状态栏/工具条/空闲目标条让位给正文，输入框仍在。
    // @GOTCHA 这里必须用**真实滚轮手势**，不能直接改 scrollTop + dispatchEvent：
    //   useBottomScroll 有 250ms 的 grace 窗口专门忽略「程序化滚动」，合成事件会被当成
    //   程序化跳转而忽略（真实用户手势走 wheel → leaveBottom，不受 grace 限制）。
    chromeStep = 'wheel-up';
    await page.locator('.messages').hover();
    await page.mouse.wheel(0, -4000);
    await settle(page, options.settleMs);
    await waitCollapsed(true);
    check(result, 'chrome collapses when scrolling up through history', (await collapsed()) === 1);
    // 状态栏豁免：收起时它既不能带上 chrome-collapsed 类，也不能藏掉实时数字。
    chromeStep = 'statusbar-exempt';
    check(result, 'status bar is exempt from auto-collapse', (await page.locator('.statusbar.chrome-collapsed').count()) === 0);
    check(
      result,
      'status bar still shows live metrics while the chrome is collapsed',
      (await page.locator('.statusbar .status-cache').isVisible()) && (await page.locator('.statusbar .status-ctx').isVisible()),
    );
    chromeStep = 'composer-visibility';
    check(
      result,
      'collapsed composer hides the toolbar row but keeps the input and send',
      (await page.locator('.inputbar.chrome-collapsed .composer-tools-left').isVisible()) === false &&
        (await page.locator('.inputbar.chrome-collapsed textarea').isVisible()) === true,
    );
    chromeStep = 'goalbar';
    check(result, 'collapsed chrome hides the idle goal bar', (await page.locator('.goalbar').count()) === 0);
    // 收起状态下直接打字：焦点一进去就应恢复完整控件（否则等于把工具条藏起来）。
    chromeStep = 'focus';
    await page.locator('.inputbar textarea').focus();
    await waitCollapsed(false);
    check(result, 'focusing the composer expands the chrome again', (await collapsed()) === 0);
    await page.locator('.inputbar textarea').blur();
    // 滑回最底部 → 恢复（用户要求的展开触发点）。
    chromeStep = 'back-to-bottom';
    await page.locator('.scroll-bottom').click();
    await waitCollapsed(false);
    check(result, 'scrolling back to the bottom expands the chrome', (await collapsed()) === 0);
    check(result, 'expanded chrome shows the composer toolbar again', await page.locator('.composer-tools-left').isVisible());
  } catch (error) {
    check(result, 'bottom chrome auto-collapse behaves', false, { error: errorSummary(error, true), step: chromeStep });
  }
}

export async function scenario(page, result, traffic, options, count) {
  result.activePhase = 'initial';
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  if (count === 0) {
    await page.locator('.passkey-gate').waitFor();
    result.readyMs = await page.evaluate(() => performance.now());
    await settle(page, options.settleMs);
    result.phases.initial = await measure(page);
    lazyChecks(result, traffic, true);
    return;
  }
  await page.locator(`.messages [data-msg-id="${messageId(count - 1)}"]`).waitFor({ state: 'attached' });
  const ready = await measure(page);
  result.readyMs = ready.elapsedMs;
  result.snapshotToReadyMs = ready.sinceSnapshotMs;
  await settle(page, options.settleMs);
  result.phases.initial = await measure(page);
  bounded(result, 'initial', result.phases.initial, options);
  lazyChecks(result, traffic);
  if (count === 1000) {
    await historyActions(page, result, options, count);
    lazyChecks(result, traffic);
    await chromeCollapseChecks(page, result, options);
  }
  if (count === 20) await selectViews(page, result, traffic, options);
}

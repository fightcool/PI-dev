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
  }
  if (count === 20) await selectViews(page, result, traffic, options);
}

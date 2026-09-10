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

async function historyActions(page, result, options, count) {
  await phase(page, result, options, 'scrollTop', () => scrollTo(page, count, false));
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

/* 🍞 AI Breadcrumb Navigation — @COUPLED=diagnostic producers; @CONTRACT=output bounds.
 * @COUPLED tests/performance/isolation.mjs, tests/performance/scenarios.mjs
 * @CONTRACT Only synthetic browser errors; no console/payload/storage capture.
 * 📖 tests/performance/README.md
 */
export function errorSummary(error, includeStack = false) {
  // Retain React's numeric production error code, strip URL queries (including
  // synthetic token parameters), and never emit arbitrary multiline fixture text.
  const clean = value => String(value ?? '').replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/g, '$1?[query omitted]');
  const summary = {
    name: clean(error.name).slice(0, 80),
    message: clean(error.message).split('\n')[0].slice(0, 500),
  };
  if (includeStack) {
    summary.frames = clean(error.stack).split('\n').filter(line => /^\s*at\s/.test(line))
      .slice(0, 5).map(line => line.trim().slice(0, 240));
  }
  return summary;
}

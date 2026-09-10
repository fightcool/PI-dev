/*
 * AI Breadcrumb Navigation
 * @COUPLED (consumers): ./QuestionNavigation.tsx;
 * vendor/pi-web-ui/tests/unit/question-navigation.test.ts
 * @WHY (design): bound rail and list work independently of conversation length.
 * @MAGIC (dimensions): 28px row pitch = 26px button + 2px gap; at most 40 rail ticks.
 */
export const QUESTION_ROW_HEIGHT = 28;
export const QUESTION_LIST_HEIGHT = 280;
export const QUESTION_RAIL_LIMIT = 40;
const OVERSCAN = 2;

export function questionRailIndices(count: number, activeIdx: number, height: number): number[] {
	const limit = Math.min(count, QUESTION_RAIL_LIMIT, Math.max(1, Math.floor(Math.max(0, height - 20) / 7)));
	if (limit === 0) return [];
	if (limit === 1) return [activeIdx >= 0 && activeIdx < count ? activeIdx : 0];
	const indices = Array.from({ length: limit }, (_, i) => Math.round((i * (count - 1)) / (limit - 1)));
	if (activeIdx >= 0 && activeIdx < count && !indices.includes(activeIdx)) {
		let closest = limit > 2 ? 1 : 0;
		for (let i = closest + 1; i < (limit > 2 ? limit - 1 : limit); i++) {
			if (Math.abs(indices[i] - activeIdx) < Math.abs(indices[closest] - activeIdx)) closest = i;
		}
		indices[closest] = activeIdx;
	}
	return indices;
}

export function questionListWindow(count: number, scrollTop: number, height: number) {
	const viewport = Math.max(0, Math.min(QUESTION_LIST_HEIGHT, height));
	const top = Math.max(0, Math.min(scrollTop, count * QUESTION_ROW_HEIGHT - viewport));
	const start = Math.max(0, Math.floor(top / QUESTION_ROW_HEIGHT) - OVERSCAN);
	const end = Math.min(count, Math.ceil((top + viewport) / QUESTION_ROW_HEIGHT) + OVERSCAN);
	return { start, end, top };
}

/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @MAGIC=window budgets.
 * @COUPLED web/src/components/message-list/useRowWindow.ts
 * @WHY Aggregate spacers bound DOM size even for collapsed history.
 */
export const MAX_WINDOW_ROWS = 80;
export const ROW_OVERSCAN = 600;

/** Initial estimates are replaced by measured heights only for mounted rows. */
export function estimateMessageHeight(role: string, customType?: string): number {
	switch (role) {
		case "user":
			return 72;
		case "assistant":
			return 280;
		case "toolResult":
			return 8;
		case "custom":
			return customType === "file" ? 96 : 72;
		default:
			return 60;
	}
}

export function rowOffsets(heights: readonly number[]): number[] {
	const offsets = [0];
	for (const h of heights) offsets.push(offsets[offsets.length - 1] + Math.max(1, h));
	return offsets;
}

/** Index containing an offset, clamped to the last row (empty => 0). */
export function rowAtOffset(offsets: readonly number[], offset: number): number {
	let lo = 0;
	let hi = Math.max(0, offsets.length - 2);
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (offsets[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** A contiguous viewport window; the first render uses the estimated bottom. */
export function visibleRowRange(offsets: readonly number[], top: number, height: number) {
	const count = offsets.length - 1;
	if (!count) return { start: 0, end: 0 };
	const firstVisible = rowAtOffset(offsets, Math.max(0, top));
	let start = rowAtOffset(offsets, Math.max(0, top - ROW_OVERSCAN));
	let end = Math.min(count, rowAtOffset(offsets, top + height + ROW_OVERSCAN) + 1);
	if (end - start > MAX_WINDOW_ROWS) {
		// Prioritize the viewport over overscan when rows are unusually short.
		start = Math.max(start, firstVisible - Math.floor(MAX_WINDOW_ROWS / 4));
		end = Math.min(end, start + MAX_WINDOW_ROWS);
	}
	return { start, end };
}

/** Keep at most one actively edited row outside the viewport, with gap spacers. */
export function renderedRowIndices(start: number, end: number, retained: number, count: number): number[] {
	const indices = Array.from({ length: end - start }, (_, i) => start + i);
	if (retained >= 0 && retained < count && (retained < start || retained >= end)) {
		indices.push(retained);
		indices.sort((a, b) => a - b);
	}
	return indices;
}

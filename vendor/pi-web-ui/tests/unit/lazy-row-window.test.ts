/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=implementation under test.
 * @COUPLED web/src/lazy-row-window.ts
 */
import { describe, expect, it } from "vitest";
import {
	MAX_WINDOW_ROWS,
	estimateMessageHeight,
	renderedRowIndices,
	rowAtOffset,
	rowOffsets,
	visibleRowRange,
} from "../../web/src/lazy-row-window";

describe("bounded message row window", () => {
	it("estimates unseen roles before measurement", () => {
		expect(estimateMessageHeight("user")).toBe(72);
		expect(estimateMessageHeight("assistant")).toBe(280);
		expect(estimateMessageHeight("custom", "file")).toBe(96);
		expect(estimateMessageHeight("custom", "other")).toBe(72);
		expect(estimateMessageHeight("toolResult")).toBe(8);
		expect(estimateMessageHeight("unknown")).toBe(60);
	});
	it("starts at the bottom of a thousand collapsed history rows", () => {
		const offsets = rowOffsets(Array(1000).fill(44));
		const { start, end } = visibleRowRange(offsets, 44000 - 800, 800);
		expect(start).toBeGreaterThan(960);
		expect(end).toBe(1000);
		expect(end - start).toBeLessThanOrEqual(MAX_WINDOW_ROWS);
	});
	it("keeps a hard row bound even with tiny measured heights", () => {
		const offsets = rowOffsets(Array(10000).fill(1));
		for (const top of [0, 2000, 9999]) {
			const { start, end } = visibleRowRange(offsets, top, 800);
			expect(end - start).toBeLessThanOrEqual(MAX_WINDOW_ROWS);
			expect(start).toBeLessThanOrEqual(rowAtOffset(offsets, top));
			expect(end).toBeGreaterThan(rowAtOffset(offsets, top));
		}
	});
	it("retains a focused editor without mounting the gap or accumulating jump targets", () => {
		expect(renderedRowIndices(980, 1000, 12, 1000)).toEqual([12, ...Array.from({ length: 20 }, (_, i) => 980 + i)]);
		expect(renderedRowIndices(980, 1000, 990, 1000)).toHaveLength(20);
		expect(renderedRowIndices(980, 1000, 1001, 1000)).toHaveLength(20);
	});
	it("locates mixed-height rows at boundaries and beyond either end", () => {
		const offsets = rowOffsets([44, 2000, 72, 44]);
		expect([-10, 0, 43, 44, 2043, 2044, 9999].map((at) => rowAtOffset(offsets, at))).toEqual([0, 0, 0, 1, 1, 2, 3]);
		expect(visibleRowRange(offsets, 700, 800)).toEqual({ start: 1, end: 3 });
	});
	it("handles empty conversations and ignores zero-height measurements", () => {
		expect(visibleRowRange([0], 0, 800)).toEqual({ start: 0, end: 0 });
		expect(rowOffsets([0, -1, 44])).toEqual([0, 1, 2, 46]);
		expect(renderedRowIndices(0, 0, -1, 0)).toEqual([]);
	});
});

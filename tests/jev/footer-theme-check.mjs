/* 🍞 @COUPLED browser-ui.mjs, footer-theme-browser.mjs,
 * vendor/pi-web-ui/web/src/styles.css, vendor/pi-web-ui/themes/white.css
 * @CONTRACT Real computed colors, WCAG contrast >= 4.5:1, no horizontal overflow.
 * @WHY Shared assertions let the focused runner avoid unrelated settings workflows.
 */
import { readFile } from "node:fs/promises";

export async function checkFooterTheme(page, panel, check) {
	const originalViewport = page.viewportSize();
	const lightTheme = await page.addStyleTag({
		content: await readFile(new URL("../../vendor/pi-web-ui/themes/white.css", import.meta.url), "utf8"),
	});
	try {
		for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await panel.waitFor({ state: "visible" });
			const readability = await panel.evaluate((element) => {
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const ctx = canvas.getContext("2d");
				// Composite from panel to card to text, including color(srgb … / alpha).
				const luminance = (...colors) => {
					ctx.clearRect(0, 0, 1, 1);
					for (const color of colors) {
						ctx.fillStyle = color;
						ctx.fillRect(0, 0, 1, 1);
					}
					return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).reduce((sum, byte, i) => {
						const value = byte / 255;
						return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
					}, 0);
				};
				const panelBg = getComputedStyle(element).backgroundColor;
				const cards = [...element.querySelectorAll(".resource-card")];
				const ratios = cards.flatMap((card) => {
					const bg = [panelBg, getComputedStyle(card).backgroundColor];
					return [...card.querySelectorAll(".resource-title, .resource-value")].map((text) => {
						const a = luminance(...bg);
						const b = luminance(...bg, getComputedStyle(text).color);
						return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
					});
				});
				const bounds = element.getBoundingClientRect();
				return {
					light: getComputedStyle(document.documentElement).colorScheme === "light",
					cards: cards.length, texts: ratios.length, minContrast: Math.min(...ratios),
					fits: bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth,
					overflow: [...element.querySelectorAll("*")].filter((node) =>
						node.scrollWidth > node.clientWidth || node.getBoundingClientRect().right > bounds.right,
					).map((node) => ({ class: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth,
						whiteSpace: getComputedStyle(node).whiteSpace })),
				};
			});
			await page.screenshot({ path: `/tmp/jev-footer-white-${viewport.width}.png` });
			check(`white Jev panel is readable at ${viewport.width}px`,
				readability.light && readability.cards === 11 && readability.texts === 22 &&
				readability.minContrast >= 4.5 && readability.fits, JSON.stringify(readability));
		}
	} finally {
		await lightTheme.evaluate((element) => element.remove());
		await page.setViewportSize(originalViewport);
	}
}

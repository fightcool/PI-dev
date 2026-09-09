import { describe, expect, it } from "vitest";
import { KNOWN_LOCALES, pickLocale } from "../../web/src/pick-locale.js";

/**
 * Which language a first visit speaks.
 *
 * Today `loadLocale()` returns "zh" when nothing is stored, so everybody who
 * has never used this instance gets Chinese and has to find the language chip.
 * The repository already carries eight translations besides zh and en — de,
 * es, fr, it, ja, ko, pt, ru — and nothing ever picks them on its own.
 *
 * So: an explicit choice always wins and is remembered; otherwise the browser
 * decides, the way every other web application works; and only if the browser
 * asks for nothing we have does the instance's configured default apply
 * (PI_WEB_LOCALE), falling back to English.
 */
describe("first-visit language", () => {
	it("an explicit choice wins over everything", () => {
		expect(pickLocale("it", ["fr-FR", "en"], "de")).toBe("it");
		// Even one that this build does not know: the pack machinery validates
		// it later, and dropping it here would silently undo the user's choice.
		expect(pickLocale("xx", ["fr"], "de")).toBe("xx");
	});

	it("ignores a stored value that is empty or blank", () => {
		expect(pickLocale("", ["fr-FR"], "en")).toBe("fr");
		expect(pickLocale("   ", ["fr-FR"], "en")).toBe("fr");
		expect(pickLocale(null, ["fr-FR"], "en")).toBe("fr");
	});

	it("takes the browser's first language it can actually speak", () => {
		expect(pickLocale(null, ["it-IT", "it", "en-US"], "en")).toBe("it");
		expect(pickLocale(null, ["nl-NL", "de-DE", "en"], "en")).toBe("de");
		expect(pickLocale(null, ["en-GB"], "it")).toBe("en");
	});

	it("understands the regional tags browsers actually send", () => {
		expect(pickLocale(null, ["zh-CN"], "en")).toBe("zh");
		expect(pickLocale(null, ["zh-TW"], "en")).toBe("zh");
		expect(pickLocale(null, ["pt-BR"], "en")).toBe("pt");
		expect(pickLocale(null, ["ja-JP"], "en")).toBe("ja");
		expect(pickLocale(null, ["IT-it"], "en")).toBe("it");
	});

	it("falls back to the instance default, then to English", () => {
		expect(pickLocale(null, ["nl-NL"], "it")).toBe("it");
		expect(pickLocale(null, [], "it")).toBe("it");
		expect(pickLocale(null, [], null)).toBe("en");
		expect(pickLocale(null, ["nl"], null)).toBe("en");
	});

	it("does not accept a default the build cannot speak", () => {
		// A typo in a systemd unit must not leave the interface showing keys.
		expect(pickLocale(null, [], "xx")).toBe("en");
	});

	it("knows the locales this build ships", () => {
		expect([...KNOWN_LOCALES].sort()).toEqual(["de", "en", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh"].sort());
	});
});

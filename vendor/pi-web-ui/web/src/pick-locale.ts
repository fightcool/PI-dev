/**
 * pick-locale — which language a first visit speaks.
 *
 * `loadLocale()` used to return "zh" when nothing was stored, so anybody who
 * had never used an instance got Chinese and had to find the language chip to
 * change it. Meanwhile the repository ships eight translations besides the two
 * core ones — de, es, fr, it, ja, ko, pt, ru — and nothing ever picked them on
 * its own.
 *
 * The order here is the one every other web application uses:
 *
 *   1. what this browser chose last time (and an explicit choice is kept even
 *      if this build does not know the code — the pack machinery validates it
 *      later, and dropping it here would silently undo the user's decision);
 *   2. the first of the browser's languages this build can actually speak;
 *   3. the instance's configured default (PI_WEB_LOCALE), for a deployment
 *      that wants to name one;
 *   4. English.
 *
 * It is a pure function so the whole order can be tested without a browser.
 */

/** Locale codes this build can show: the two core ones plus every pack. */
export const KNOWN_LOCALES = ["zh", "en", "de", "es", "fr", "it", "ja", "ko", "pt", "ru"] as const;

/**
 * The locale to start with.
 *
 * `saved` is what the previous visit stored, `languages` is
 * `navigator.languages`, `fallback` is the instance default.
 */
export function pickLocale(
	saved: string | null | undefined,
	languages: readonly string[] | null | undefined,
	fallback: string | null | undefined,
	known: readonly string[] = KNOWN_LOCALES,
): string {
	const chosen = (saved ?? "").trim();
	if (chosen) return chosen;

	for (const raw of languages ?? []) {
		// Browsers send tags like "it-IT", "zh-CN", "pt-BR": try the whole tag,
		// then its primary subtag, so a regional variant lands on its language.
		const tag = String(raw ?? "")
			.trim()
			.toLowerCase()
			.replace(/_/g, "-");
		if (!tag) continue;
		if (known.includes(tag)) return tag;
		const primary = tag.split("-")[0];
		if (primary && known.includes(primary)) return primary;
	}

	// A default this build cannot speak — a typo in a unit file — must not
	// leave the interface showing raw keys.
	const configured = (fallback ?? "").trim().toLowerCase();
	if (configured && known.includes(configured)) return configured;
	return "en";
}

/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED sync needed: server/settings-service.ts, server/client-state.ts, server/agent-service.ts
 *   @BUGFIX 2026-09-22 shared settings must be reread before filter reads/writes
 * ──────────────────────────────────────────────────
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

type TestEvents = { settings: number; filters: number; messages: unknown[]; retryRead?: number };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(
	clientId: string,
	stateStore: ClientStateStore,
	events: TestEvents,
): SettingsService {
	let service: SettingsService;
	const host: SettingsHost = {
		clientId,
		stateStore,
		emit: (msg) => events.messages.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("session is not needed for this test");
		},
		cwd: () => "/tmp",
		agentDir: () => "/tmp",
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {
			events.retryRead = service.current.retryMaxAttempts;
		},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		settingsChanged: () => events.settings++,
		modelFiltersChanged: () => events.filters++,
	};
	service = new SettingsService(host, { list: () => [] } as unknown as SubagentTemplatesStore);
	return service;
}

describe("shared model filter settings", () => {
	it("two service instances reread filters and never overwrite another client's filter", async () => {
		const dir = mkdtempSync(join(tmpdir(), "settings-sync-"));
		dirs.push(dir);
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const aEvents: TestEvents = { settings: 0, filters: 0, messages: [] };
		const bEvents: TestEvents = { settings: 0, filters: 0, messages: [] };
		const a = makeService("client-a", store, aEvents);
		const b = makeService("client-b", store, bEvents);
		const cEvents: TestEvents = { settings: 0, filters: 0, messages: [] };
		const c = makeService("client-c", store, cEvents);

		await a.set({ hiddenModels: ["p/hidden"], retryMaxAttempts: 11 });
		expect(aEvents.retryRead).toBe(11);
		expect(b.hiddenModels).toEqual(["p/hidden"]);
		expect(aEvents).toMatchObject({ settings: 1, filters: 1 });

		// c was constructed before the write and has not read a filter getter. Its
		// unrelated full settings save must still merge the latest shared filter.
		await c.set({ thinkingWrap: false });
		expect(store.getSettings("client-c").hiddenModels).toEqual(["p/hidden"]);
		expect(store.getSettings("client-c").thinkingWrap).toBe(false);

		await b.set({
			retiredModelRoutes: ["p/retired"],
			modelRouteAliases: { "p/old": "p/new" },
		});
		expect(a.hiddenModels).toEqual(["p/hidden"]);
		expect(a.modelRoutingRules.retired).toEqual(["p/retired"]);
		expect(a.modelRoutingRules.aliases).toEqual({ "p/old": "p/new" });
		expect(bEvents).toMatchObject({ settings: 1, filters: 1 });

		a.push();
		const state = aEvents.messages.at(-1) as { type: string; settings: { hiddenModels: string[]; retiredModelRoutes: string[] } };
		expect(state.type).toBe("settings_state");
		expect(state.settings.hiddenModels).toEqual(["p/hidden"]);
		expect(state.settings.retiredModelRoutes).toEqual(["p/retired"]);
	});
});

import { describe, expect, it, vi } from "vitest";
import { createPluginViewLoader, type LoadedPluginView, type PluginViewModule } from "../../web/src/plugin-loader";
import type { UiPluginInfo } from "../../web/src/types";

const plugin = (id: string, extra: Partial<UiPluginInfo> = {}): UiPluginInfo => ({
	id,
	name: id,
	hasClient: true,
	...extra,
});
const module = () => ({ default: { mount: vi.fn() } });
function deferred() {
	let resolve!: (value: { default: PluginViewModule }) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<{ default: PluginViewModule }>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** 🍞 @COUPLED web/src/plugin-loader.ts: first access, cleanup, asynchronous catalog changes. */
describe("plugin view loading", () => {
	it("does not import on sync; loads only the requested view once", async () => {
		const importer = vi.fn(async () => module());
		const loader = createPluginViewLoader(importer);
		let views: LoadedPluginView[] = [];
		loader.subscribe((next) => {
			views = next;
		});
		loader.sync([plugin("one"), plugin("two")], 7);
		expect(importer).not.toHaveBeenCalled();
		await Promise.all([loader.request("one"), loader.request("one")]);
		expect(importer).toHaveBeenCalledTimes(1);
		expect(importer).toHaveBeenCalledWith("/plugins/one/client/entry.mjs?e=7");
		expect(views.map((v) => v.info.id)).toEqual(["one"]);
		const entry = views[0];
		loader.sync([plugin("one"), plugin("two")], 7);
		await loader.request("one");
		expect(views[0]).toBe(entry);
		expect(importer).toHaveBeenCalledTimes(1);
	});

	it("rejects missing, disabled, errored, server-only and renderer-only views", async () => {
		const importer = vi.fn(async () => module());
		const loader = createPluginViewLoader(importer);
		loader.sync(
			[plugin("renderer", { view: false }), plugin("bad", { error: "bad" }), plugin("server", { hasClient: false })],
			1,
		);
		await Promise.all(["missing", "disabled", "renderer", "bad", "server"].map(loader.request));
		expect(importer).not.toHaveBeenCalled();
	});

	it("publishes disabled/removed cleanup immediately while another import is pending", async () => {
		const pending = deferred();
		const importer = vi.fn().mockResolvedValueOnce(module()).mockReturnValueOnce(pending.promise);
		const loader = createPluginViewLoader(importer);
		let views: LoadedPluginView[] = [];
		const unsubscribe = loader.subscribe((next) => {
			views = next;
		});
		loader.sync([plugin("one"), plugin("two")], 1);
		await loader.request("one");
		const second = loader.request("two");
		loader.sync([plugin("two")], 1);
		expect(views).toEqual([]);
		pending.resolve(module());
		await second;
		expect(views.map((v) => v.info.id)).toEqual(["two"]);
		unsubscribe();
	});

	it("ignores a stale success after disable then re-enable in the same epoch", async () => {
		const old = deferred();
		const fresh = deferred();
		const loader = createPluginViewLoader(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise));
		let views: LoadedPluginView[] = [];
		loader.subscribe((next) => {
			views = next;
		});
		loader.sync([plugin("one")], 1);
		const first = loader.request("one");
		await Promise.resolve();
		loader.sync([], 1);
		loader.sync([plugin("one")], 1);
		const second = loader.request("one");
		old.resolve(module());
		await first;
		expect(views).toEqual([]);
		const current = module();
		fresh.resolve(current);
		await second;
		expect(views[0].module).toBe(current.default);
	});

	it.each(["success", "failure"])("ignores old epoch %s after a new import completes", async (outcome) => {
		const old = deferred();
		const current = module();
		const importer = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
		const loader = createPluginViewLoader(importer);
		let views: LoadedPluginView[] = [];
		loader.subscribe((next) => {
			views = next;
		});
		loader.sync([plugin("one")], 1);
		const first = loader.request("one");
		await Promise.resolve();
		loader.sync([plugin("one")], 2);
		expect(views).toEqual([]);
		await loader.request("one");
		if (outcome === "success") old.resolve(module());
		else old.reject(new Error("stale"));
		await first;
		expect(views[0].module).toBe(current.default);
		expect(importer).toHaveBeenLastCalledWith("/plugins/one/client/entry.mjs?e=2");
	});

	it("cancels a not-yet-started import when eligibility is revoked", async () => {
		const importer = vi.fn(async () => module());
		const loader = createPluginViewLoader(importer);
		loader.sync([plugin("one")], 1);
		const pending = loader.request("one");
		loader.sync([], 1);
		await pending;
		expect(importer).not.toHaveBeenCalled();
	});

	it("holds failures until invalidation, then allows a requested retry", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const importer = vi.fn().mockRejectedValueOnce(new Error("broken")).mockResolvedValue(module());
			const loader = createPluginViewLoader(importer);
			loader.sync([plugin("one")], 1);
			await loader.request("one");
			loader.sync([plugin("one")], 1);
			await loader.request("one");
			expect(importer).toHaveBeenCalledTimes(1);
			loader.sync([plugin("one")], 2);
			expect(importer).toHaveBeenCalledTimes(1);
			await loader.request("one");
			expect(importer).toHaveBeenCalledTimes(2);
		} finally {
			error.mockRestore();
		}
	});
});

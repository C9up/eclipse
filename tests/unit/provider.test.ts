import { describe, expect, it, vi } from "vitest";
import EclipseProvider, {
	type EclipseAppContext,
} from "../../src/EclipseProvider.js";
import { defineConfig, LockManager, stores } from "../../src/LockManager.js";
import { clearLocks, getLocks } from "../../src/services/main.js";

/** A fake host — eclipse must never need the real container to be testable. */
function app(config: Record<string, unknown>): EclipseAppContext & {
	bindings: Map<unknown, () => unknown>;
} {
	const bindings = new Map<unknown, () => unknown>();
	const resolved = new Map<unknown, unknown>();
	return {
		bindings,
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve(token: unknown): Promise<unknown> {
				// The fake mirrors the real container: one instance per token.
				if (!resolved.has(token)) {
					const factory = bindings.get(token);
					if (!factory) throw new Error(`unbound: ${String(token)}`);
					resolved.set(token, await factory());
				}
				return resolved.get(token);
			},
		},
		config: { get: (key: string) => config[key] },
	};
}

describe("EclipseProvider", () => {
	it("falls back to an in-process manager when no config file exists", async () => {
		clearLocks();
		const host = app({});
		const provider = new EclipseProvider(host);
		provider.register();
		await provider.boot();
		expect(getLocks()).toBeInstanceOf(LockManager);
		expect(await getLocks()?.createLock("k").acquireImmediately()).toBe(true);
		await provider.shutdown();
	});

	it("refuses a config/lock.ts that is not a lock config", async () => {
		const host = app({ lock: { driver: "redis" } });
		const provider = new EclipseProvider(host);
		provider.register();
		await expect(provider.boot()).rejects.toThrow(/defineConfig/);
	});

	it("binds both the namespaced and the bare container token", async () => {
		const host = app({
			lock: defineConfig({
				default: "memory",
				stores: { memory: stores.memory() },
			}),
		});
		new EclipseProvider(host).register();
		expect(host.bindings.has("eclipse.lock")).toBe(true);
		expect(host.bindings.has("lock")).toBe(true);
	});

	it("clears the singleton on shutdown, but only while it is still ours", async () => {
		clearLocks();
		const first = new EclipseProvider(app({}));
		first.register();
		await first.boot();

		const second = new EclipseProvider(app({}));
		second.register();
		await second.boot();
		const secondManager = getLocks();

		// Two applications can share a process. The first shutting down must
		// not unpublish the manager the second booted.
		await first.shutdown();
		expect(getLocks()).toBe(secondManager);
		await second.shutdown();
		expect(getLocks()).toBeUndefined();
	});

	it("disconnects the stores it built on shutdown", async () => {
		const disconnect = vi.fn().mockResolvedValue(undefined);
		const host = app({
			lock: {
				default: "a",
				stores: {
					a: () => ({
						save: () => Promise.resolve(true),
						delete: () => Promise.resolve(),
						forceDelete: () => Promise.resolve(),
						exists: () => Promise.resolve(false),
						extend: () => Promise.resolve(),
						disconnect,
					}),
				},
			},
		});
		const provider = new EclipseProvider(host);
		provider.register();
		await provider.boot();
		getLocks()?.use();
		await provider.shutdown();
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it("refuses a container that rebound the token to something else", async () => {
		const host = app({});
		const provider = new EclipseProvider(host);
		provider.register();
		// A host is free to rebind; it must not then be handed to callers as a
		// LockManager and fail on the first createLock.
		host.bindings.set(LockManager, () => ({ notALockManager: true }));
		await expect(provider.boot()).rejects.toThrow(/not a LockManager/);
	});
});

import { describe, expect, it, vi } from "vitest";
import EclipseProvider, {
	type EclipseAppContext,
} from "../../src/EclipseProvider.js";
import { EclipseError } from "../../src/errors.js";
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

const memoryConfig = () =>
	defineConfig({ default: "memory", stores: { memory: stores.memory() } });

describe("EclipseProvider", () => {
	it("refuses to boot without config/lock.ts rather than lock in-process only", async () => {
		// An in-process fallback would let every replica take every lock, and
		// nothing would say so.
		clearLocks();
		const host = app({});
		const provider = new EclipseProvider(host);
		provider.register();
		const error = await provider.boot().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EclipseError);
		if (error instanceof EclipseError) {
			expect(error.code).toBe("E_ECLIPSE_MISSING_CONFIG");
		}
		expect(getLocks()).toBeUndefined();
	});

	it("refuses a config/lock.ts that is not a lock config", async () => {
		const host = app({ lock: { driver: "redis" } });
		const provider = new EclipseProvider(host);
		provider.register();
		const error = await provider.boot().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EclipseError);
		if (error instanceof EclipseError) {
			expect(error.code).toBe("E_ECLIPSE_INVALID_CONFIG");
			expect(error.message).toMatch(/defineConfig/);
		}
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
		const first = new EclipseProvider(app({ lock: memoryConfig() }));
		first.register();
		await first.boot();

		const second = new EclipseProvider(app({ lock: memoryConfig() }));
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

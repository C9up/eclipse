import { describe, expect, it, vi } from "vitest";
import { UnknownStoreError } from "../../src/errors.js";
import { defineConfig, LockManager, stores } from "../../src/LockManager.js";
import type { LockStore } from "../../src/types.js";

describe("LockManager", () => {
	it("refuses a config whose default names a store that is not declared", () => {
		expect(
			() =>
				new LockManager({
					default: "redis",
					stores: { memory: stores.memory() },
				}),
		).toThrow(UnknownStoreError);
	});

	it("builds each store once and reuses it", () => {
		const factory = vi.fn(
			() =>
				new (class implements LockStore {
					save = () => Promise.resolve(true);
					delete = () => Promise.resolve();
					forceDelete = () => Promise.resolve();
					exists = () => Promise.resolve(false);
					extend = () => Promise.resolve();
				})(),
		);
		const locks = new LockManager({ default: "a", stores: { a: factory } });
		expect(locks.use()).toBe(locks.use("a"));
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("does not build a store the application never asks for", () => {
		const unused = vi.fn();
		const locks = new LockManager({
			default: "memory",
			stores: { memory: stores.memory(), redis: unused },
		});
		locks.createLock("k");
		expect(unused).not.toHaveBeenCalled();
	});

	it("names the declared stores when one is missing", () => {
		const locks = new LockManager({
			default: "memory",
			stores: { memory: stores.memory() },
		});
		expect(() => locks.use("nope")).toThrow(/memory/);
	});

	it("a lock created without a TTL inherits the config's", async () => {
		vi.useFakeTimers();
		try {
			const locks = new LockManager(
				defineConfig({
					default: "memory",
					stores: { memory: stores.memory() },
					ttl: "50ms",
				}),
			);
			const lock = locks.createLock("k");
			await lock.acquireImmediately();
			expect(lock.getRemainingTime()).toBe(50);
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts a human duration wherever a TTL is taken", async () => {
		vi.useFakeTimers();
		try {
			const locks = new LockManager({
				default: "memory",
				stores: { memory: stores.memory() },
			});
			const lock = locks.createLock("k", "2m");
			await lock.acquireImmediately();
			expect(lock.getRemainingTime()).toBe(120_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("disconnects only the stores that were actually built", async () => {
		const disconnect = vi.fn().mockResolvedValue(undefined);
		const withDisconnect = (): LockStore => ({
			save: () => Promise.resolve(true),
			delete: () => Promise.resolve(),
			forceDelete: () => Promise.resolve(),
			exists: () => Promise.resolve(false),
			extend: () => Promise.resolve(),
			disconnect,
		});
		const locks = new LockManager({
			default: "a",
			stores: { a: withDisconnect, b: withDisconnect },
		});
		locks.use("a");
		await locks.disconnectAll();
		expect(disconnect).toHaveBeenCalledTimes(1);
	});

	it("stores.redis defers resolving the connection to the first lock", () => {
		// config/lock.ts is read before the container exists, so naming a
		// connection must not reach for it at config time.
		expect(() => stores.redis({ connection: "main" })).not.toThrow();
	});

	it("stores.redis accepts a client directly, without touching quasar", async () => {
		const redis = {
			set: vi.fn().mockResolvedValue("OK"),
			eval: vi.fn().mockResolvedValue(1),
			del: vi.fn().mockResolvedValue(1),
			exists: vi.fn().mockResolvedValue(0),
		};
		const locks = new LockManager({
			default: "redis",
			stores: { redis: stores.redis({ client: redis, prefix: "t:" }) },
		});
		expect(await locks.createLock("k", 1_000).acquireImmediately()).toBe(true);
		expect(redis.set).toHaveBeenCalledWith(
			"t:k",
			expect.any(String),
			"PX",
			1_000,
			"NX",
		);
	});
});

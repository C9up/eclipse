import { describe, expect, it, vi } from "vitest";
import { InvalidTtlError, LockNotOwnedError } from "../../src/errors.js";
import { Lock } from "../../src/Lock.js";
import { LockManager, stores } from "../../src/LockManager.js";
import { MemoryStore } from "../../src/stores/MemoryStore.js";
import type { LockStore, ResolvedLockConfig } from "../../src/types.js";

const config = (
	over: Partial<ResolvedLockConfig> = {},
): ResolvedLockConfig => ({
	retry: { attempts: Number.POSITIVE_INFINITY, delay: 10, timeout: undefined },
	ttl: 1_000,
	...over,
});

const manager = (): LockManager =>
	new LockManager({ default: "memory", stores: { memory: stores.memory() } });

describe("Lock", () => {
	it("gives each lock its own owner token", () => {
		const store = new MemoryStore();
		const a = new Lock("k", store, config());
		const b = new Lock("k", store, config());
		expect(a.getOwner()).not.toBe(b.getOwner());
	});

	it("refuses a TTL that expires the instant it is taken", () => {
		expect(
			() => new Lock("k", new MemoryStore(), config(), undefined, 0),
		).toThrow(InvalidTtlError);
		expect(
			() => new Lock("k", new MemoryStore(), config(), undefined, -5),
		).toThrow(InvalidTtlError);
	});

	it("acquireImmediately reports instead of waiting — what a scheduler tick needs", async () => {
		const store = new MemoryStore();
		const first = new Lock("task", store, config());
		const second = new Lock("task", store, config());
		expect(await first.acquireImmediately()).toBe(true);
		expect(await second.acquireImmediately()).toBe(false);
	});

	it("run returns [true, result] and releases afterwards", async () => {
		const store = new MemoryStore();
		const lock = new Lock("k", store, config());
		const [ran, value] = await lock.run(async () => 42);
		expect(ran).toBe(true);
		expect(value).toBe(42);
		expect(await store.exists("k")).toBe(false);
	});

	it("run tells 'ran and returned undefined' apart from 'never ran'", async () => {
		const store = new MemoryStore();
		const held = new Lock("k", store, config());
		await held.acquireImmediately();

		const ranUndefined = await new Lock("free", store, config()).run(
			async () => undefined,
		);
		expect(ranUndefined).toEqual([true, undefined]);

		const neverRan = await new Lock("k", store, config()).runImmediately(
			async () => "unreachable",
		);
		expect(neverRan).toEqual([false, null]);
	});

	it("releases even when the callback throws, and lets the callback's error through", async () => {
		const store = new MemoryStore();
		const lock = new Lock("k", store, config());
		await expect(
			lock.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await store.exists("k")).toBe(false);
	});

	it("does not let a lost lease mask the callback's own error", async () => {
		// The named deviation: upstream calls release() in the finally, so a
		// callback that outlived its TTL surfaces E_LOCK_NOT_OWNED instead of
		// whatever actually went wrong.
		const store = new MemoryStore();
		const lock = new Lock("k", store, config(), undefined, 20);
		await expect(
			lock.run(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				throw new Error("the real failure");
			}),
		).rejects.toThrow("the real failure");
	});

	it("a direct release still reports a lease that is gone", async () => {
		const store = new MemoryStore();
		const lock = new Lock("k", store, config(), undefined, 20);
		await lock.acquireImmediately();
		await new Promise((resolve) => setTimeout(resolve, 40));
		await expect(lock.release()).rejects.toBeInstanceOf(LockNotOwnedError);
	});

	it("waits for the holder, then takes the lock — the cache-stampede path", async () => {
		const store = new MemoryStore();
		const holder = new Lock("k", store, config(), undefined, 60);
		await holder.acquireImmediately();

		const waiter = new Lock("k", store, config());
		const acquired = waiter.acquire({ retry: { delay: 5 } });
		setTimeout(() => void holder.release(), 20);
		expect(await acquired).toBe(true);
	});

	it("gives up after the configured number of attempts", async () => {
		const store = new MemoryStore();
		await new Lock("k", store, config()).acquireImmediately();
		const waiter = new Lock("k", store, config());
		expect(await waiter.acquire({ retry: { attempts: 3, delay: 1 } })).toBe(
			false,
		);
	});

	it("respects the retry timeout instead of overshooting by a full delay", async () => {
		// Upstream sleeps the whole delay before re-checking the budget, so a
		// 40ms timeout with a 200ms delay returns after ~200ms.
		const store = new MemoryStore();
		await new Lock("k", store, config()).acquireImmediately();
		const waiter = new Lock("k", store, config());
		const started = Date.now();
		expect(await waiter.acquire({ retry: { delay: 200, timeout: 40 } })).toBe(
			false,
		);
		expect(Date.now() - started).toBeLessThan(150);
	});

	it("treats timeout: 0 as 'do not wait', not 'wait forever'", async () => {
		const store = new MemoryStore();
		await new Lock("k", store, config()).acquireImmediately();
		const waiter = new Lock("k", store, config());
		expect(await waiter.acquire({ retry: { delay: 50, timeout: 0 } })).toBe(
			false,
		);
	});

	it("extend pushes the expiry out, so long work need not take a long lease", async () => {
		const store = new MemoryStore();
		const lock = new Lock("k", store, config(), undefined, 40);
		await lock.acquireImmediately();
		await lock.extend(500);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(await store.exists("k")).toBe(true);
		await lock.release();
	});

	it("extend refuses a duration that bounds nothing", async () => {
		const lock = new Lock("k", new MemoryStore(), config());
		await lock.acquireImmediately();
		await expect(lock.extend(0)).rejects.toBeInstanceOf(InvalidTtlError);
	});

	it("serialize/restore hands a held lease to another process", async () => {
		const locks = manager();
		const held = locks.createLock("hand-off", 5_000);
		expect(await held.acquireImmediately()).toBe(true);

		const payload = JSON.parse(JSON.stringify(held.serialize()));
		const restored = locks.restoreLock(payload);
		expect(restored.getOwner()).toBe(held.getOwner());
		// The restored lock owns the lease, so it may release it.
		await restored.release();
		expect(await locks.createLock("hand-off").acquireImmediately()).toBe(true);
	});

	it("reports remaining time, clamped at zero once the lease has lapsed", async () => {
		vi.useFakeTimers();
		try {
			const lock = new Lock("k", new MemoryStore(), config(), undefined, 1_000);
			expect(lock.getRemainingTime()).toBe(null);
			await lock.acquireImmediately();
			vi.advanceTimersByTime(400);
			expect(lock.getRemainingTime()).toBe(600);
			expect(lock.isExpired()).toBe(false);
			vi.advanceTimersByTime(1_000);
			expect(lock.getRemainingTime()).toBe(0);
			expect(lock.isExpired()).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a never-expiring lock is never expired", async () => {
		const lock = new Lock("k", new MemoryStore(), config(), undefined, null);
		await lock.acquireImmediately();
		expect(lock.isExpired()).toBe(false);
		expect(lock.getRemainingTime()).toBe(null);
	});

	it("forceRelease is the break-glass path for a lease nobody owns any more", async () => {
		const store = new MemoryStore();
		const stuck = new Lock("k", store, config(), undefined, null);
		await stuck.acquireImmediately();
		await new Lock("k", store, config()).forceRelease();
		expect(await store.exists("k")).toBe(false);
	});

	it("surfaces a store failure that is not a lost lease", async () => {
		const broken: LockStore = {
			save: () => Promise.resolve(true),
			delete: () => Promise.reject(new Error("store is down")),
			forceDelete: () => Promise.resolve(),
			exists: () => Promise.resolve(true),
			extend: () => Promise.resolve(),
		};
		const lock = new Lock("k", broken, config());
		await expect(lock.run(async () => "done")).rejects.toThrow("store is down");
	});

	it("reports the key it leases", () => {
		expect(
			new Lock("invoices:nightly", new MemoryStore(), config()).getKey(),
		).toBe("invoices:nightly");
	});

	it("isLocked asks whether ANYONE holds it, not whether we do", async () => {
		const store = new MemoryStore();
		const mine = new Lock("k", store, config());
		const theirs = new Lock("k", store, config());
		expect(await mine.isLocked()).toBe(false);
		await theirs.acquireImmediately();
		expect(await mine.isLocked()).toBe(true);
	});
});

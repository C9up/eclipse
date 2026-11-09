import { afterEach, describe, expect, it, vi } from "vitest";
import { LockNotOwnedError } from "../../src/errors.js";
import { LockManager, stores } from "../../src/LockManager.js";
import { schedulerBackend } from "../../src/scheduler.js";
import { MemoryStore } from "../../src/stores/MemoryStore.js";
import type { LockStore } from "../../src/types.js";

const manager = (): LockManager =>
	new LockManager({ default: "memory", stores: { memory: stores.memory() } });

describe("schedulerBackend", () => {
	it("lets exactly one instance take a tick", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		expect(await a.acquire("nightly", 1_000)).toBe(true);
		expect(await b.acquire("nightly", 1_000)).toBe(false);
	});

	it("frees the name on release, so the next tick can take it", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		await a.acquire("nightly", 1_000);
		await a.release("nightly");
		expect(await b.acquire("nightly", 1_000)).toBe(true);
	});

	it("releasing a name this instance never took does nothing", async () => {
		const backend = schedulerBackend(manager());
		await expect(backend.release("never-acquired")).resolves.toBeUndefined();
	});

	it("one instance cannot release another's lease", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		await a.acquire("nightly", 1_000);
		// b never held it, so its release is a no-op rather than a theft.
		await b.release("nightly");
		expect(await b.acquire("nightly", 1_000)).toBe(false);
	});

	it("a task that lost its lease does not raise on the way out, and says so", async () => {
		const locks = manager();
		const lost: string[] = [];
		const backend = schedulerBackend(locks, {
			onLeaseLost: (name) => lost.push(name),
		});
		await backend.acquire("short", 1_000);
		// Someone broke the lease and took the name while the task ran.
		await locks.createLock("schedule:short").forceRelease();
		expect(
			await locks.createLock("schedule:short", 1_000).acquireImmediately(),
		).toBe(true);
		// The scheduler calls release() from a finally; raising there would
		// replace whatever the task itself was reporting.
		await expect(backend.release("short")).resolves.toBeUndefined();
		expect(lost).toEqual(["short"]);
	});

	it("namespaces scheduler leases away from application ones", async () => {
		const locks = manager();
		const backend = schedulerBackend(locks, { prefix: "schedule:" });
		await backend.acquire("reports", 1_000);
		// An application lock on the bare name is unaffected.
		expect(await locks.createLock("reports", 1_000).acquireImmediately()).toBe(
			true,
		);
	});

	it("resolves the manager lazily — config is read before the app boots", async () => {
		let built: LockManager | undefined;
		const backend = schedulerBackend(() => {
			built ??= manager();
			return built;
		});
		expect(built).toBeUndefined();
		expect(await backend.acquire("t", 1_000)).toBe(true);
		expect(built).toBeInstanceOf(LockManager);
	});

	describe("keeping the lease alive while the task runs", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("renews the lease, so a task longer than the TTL never runs twice", async () => {
			vi.useFakeTimers();
			const locks = manager();
			const a = schedulerBackend(locks);
			const b = schedulerBackend(locks);
			expect(await a.acquire("nightly", 200)).toBe(true);
			// A 1s task under a 200ms lease: every other instance's tick in
			// between must still find the name taken.
			for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
				await vi.advanceTimersByTimeAsync(50);
				expect(await b.acquire("nightly", 200)).toBe(false);
			}
			await a.release("nightly");
			expect(await b.acquire("nightly", 200)).toBe(true);
			await b.release("nightly");
		});

		it("stops renewing on release, so the lease is not resurrected", async () => {
			vi.useFakeTimers();
			const store = new MemoryStore();
			const extend = vi.spyOn(store, "extend");
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			const backend = schedulerBackend(locks);
			await backend.acquire("t", 300);
			await vi.advanceTimersByTimeAsync(350);
			const renewals = extend.mock.calls.length;
			expect(renewals).toBeGreaterThan(0);
			await backend.release("t");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(extend.mock.calls.length).toBe(renewals);
			expect(await store.exists("schedule:t")).toBe(false);
		});

		it("renews by the TTL only, so a crashed holder still frees the name after it", async () => {
			vi.useFakeTimers();
			const store = new MemoryStore();
			const extend = vi.spyOn(store, "extend");
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			await schedulerBackend(locks).acquire("t", 300);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(extend).toHaveBeenCalled();
			for (const call of extend.mock.calls) expect(call[2]).toBe(300);
		});

		it("reports a lease another holder took, and stops renewing it", async () => {
			vi.useFakeTimers();
			const store = new MemoryStore();
			const extend = vi.spyOn(store, "extend");
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			const lost: Array<[string, unknown]> = [];
			const backend = schedulerBackend(locks, {
				onLeaseLost: (name, error) => lost.push([name, error]),
			});
			await backend.acquire("t", 300);
			await locks.createLock("schedule:t").forceRelease();
			await locks.createLock("schedule:t", 5_000).acquireImmediately();
			await vi.advanceTimersByTimeAsync(150);
			expect(lost).toHaveLength(1);
			expect(lost[0]?.[0]).toBe("t");
			expect(lost[0]?.[1]).toBeInstanceOf(LockNotOwnedError);
			const attempts = extend.mock.calls.length;
			await vi.advanceTimersByTimeAsync(1_000);
			expect(extend.mock.calls.length).toBe(attempts);
			// Reported once, not again on the way out.
			await backend.release("t");
			expect(lost).toHaveLength(1);
		});

		it("keeps renewing through a store failure, which may be transient", async () => {
			vi.useFakeTimers();
			const inner = new MemoryStore();
			let failNext = true;
			const store: LockStore = {
				save: (k, o, t) => inner.save(k, o, t),
				delete: (k, o) => inner.delete(k, o),
				forceDelete: (k) => inner.forceDelete(k),
				exists: (k) => inner.exists(k),
				extend: (k, o, d) => {
					if (failNext) {
						failNext = false;
						return Promise.reject(new Error("ECONNRESET"));
					}
					return inner.extend(k, o, d);
				},
			};
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			const lost: string[] = [];
			const backend = schedulerBackend(locks, {
				onLeaseLost: (name) => lost.push(name),
			});
			await backend.acquire("t", 300);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(lost).toEqual([]);
			expect(await inner.exists("schedule:t")).toBe(true);
			await backend.release("t");
		});
	});

	describe("the ttl option", () => {
		it("overrides the scheduler's single global TTL", async () => {
			const store = new MemoryStore();
			const save = vi.spyOn(store, "save");
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			const backend = schedulerBackend(locks, { ttl: "10m" });
			await backend.acquire("t", 60_000);
			expect(save).toHaveBeenCalledWith(
				"schedule:t",
				expect.any(String),
				600_000,
			);
			await backend.release("t");
		});

		it("leaves the scheduler's TTL in place when not set", async () => {
			const store = new MemoryStore();
			const save = vi.spyOn(store, "save");
			const locks = new LockManager({
				default: "s",
				stores: { s: () => store },
			});
			const backend = schedulerBackend(locks);
			await backend.acquire("t", 60_000);
			expect(save).toHaveBeenCalledWith(
				"schedule:t",
				expect.any(String),
				60_000,
			);
			await backend.release("t");
		});
	});
});

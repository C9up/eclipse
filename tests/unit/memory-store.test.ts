import { describe, expect, it, vi } from "vitest";
import { LockNotOwnedError } from "../../src/errors.js";
import { MemoryStore } from "../../src/stores/MemoryStore.js";

describe("MemoryStore", () => {
	it("gives the lock to the first caller and refuses the second", async () => {
		const store = new MemoryStore();
		expect(await store.save("k", "owner-a", 1_000)).toBe(true);
		expect(await store.save("k", "owner-b", 1_000)).toBe(false);
	});

	it("frees the key once the lease has elapsed, without anyone cleaning up", async () => {
		vi.useFakeTimers();
		try {
			const store = new MemoryStore();
			expect(await store.save("k", "owner-a", 1_000)).toBe(true);
			vi.advanceTimersByTime(1_001);
			expect(await store.exists("k")).toBe(false);
			expect(await store.save("k", "owner-b", 1_000)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds a null lease forever", async () => {
		vi.useFakeTimers();
		try {
			const store = new MemoryStore();
			await store.save("k", "owner-a", null);
			vi.advanceTimersByTime(10 * 86_400_000);
			expect(await store.exists("k")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses to release a lease held by someone else", async () => {
		const store = new MemoryStore();
		await store.save("k", "owner-a", 1_000);
		await expect(store.delete("k", "owner-b")).rejects.toBeInstanceOf(
			LockNotOwnedError,
		);
		expect(await store.exists("k")).toBe(true);
	});

	it("refuses to release a lease that has already lapsed", async () => {
		// The named deviation from upstream: its memory driver returns quietly
		// here while its Redis driver throws. Both must report.
		vi.useFakeTimers();
		try {
			const store = new MemoryStore();
			await store.save("k", "owner-a", 1_000);
			vi.advanceTimersByTime(1_001);
			await expect(store.delete("k", "owner-a")).rejects.toBeInstanceOf(
				LockNotOwnedError,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forceDelete takes the key back from whoever holds it", async () => {
		const store = new MemoryStore();
		await store.save("k", "owner-a", 1_000);
		await store.forceDelete("k");
		expect(await store.exists("k")).toBe(false);
	});

	it("extends only for the owner, and pushes the expiry out from now", async () => {
		vi.useFakeTimers();
		try {
			const store = new MemoryStore();
			await store.save("k", "owner-a", 1_000);
			await expect(store.extend("k", "owner-b", 5_000)).rejects.toBeInstanceOf(
				LockNotOwnedError,
			);
			await store.extend("k", "owner-a", 5_000);
			vi.advanceTimersByTime(4_000);
			expect(await store.exists("k")).toBe(true);
			vi.advanceTimersByTime(1_001);
			expect(await store.exists("k")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	describe("sweeping", () => {
		/**
		 * The size of every large map iterated while `run` executes. A sweep is
		 * the only full scan the store does, so this counts sweeps and shows
		 * how big the map was when each one ran.
		 */
		async function scans(run: () => Promise<void>): Promise<number[]> {
			const sizes: number[] = [];
			const iterate = Map.prototype[Symbol.iterator];
			const spy = vi
				.spyOn(Map.prototype, Symbol.iterator)
				.mockImplementation(function (this: Map<unknown, unknown>) {
					if (this.size >= 500) sizes.push(this.size);
					return iterate.call(this);
				});
			try {
				await run();
			} finally {
				spy.mockRestore();
			}
			return sizes;
		}

		it("does not scan the whole map on every save once it holds many live keys", async () => {
			const store = new MemoryStore();
			for (let i = 0; i < 10_000; i++) {
				await store.save(`live:${i}`, "o", 3_600_000);
			}
			const sizes = await scans(async () => {
				for (let i = 0; i < 1_000; i++) {
					await store.save(`new:${i}`, "o", 3_600_000);
				}
			});
			expect(sizes.length).toBeLessThanOrEqual(1);
		});

		it("still reclaims lapsed keys as the map grows", async () => {
			vi.useFakeTimers();
			try {
				const store = new MemoryStore();
				for (let i = 0; i < 1_500; i++) await store.save(`old:${i}`, "o", 10);
				vi.advanceTimersByTime(11);
				const sizes = await scans(async () => {
					for (let i = 0; i < 1_200; i++) {
						await store.save(`new:${i}`, "o", 3_600_000);
					}
				});
				// One sweep collected the 1500 lapsed keys; had it not, the map
				// would hold 2700 by the end, and the next scan would see them.
				expect(sizes.length).toBeGreaterThan(0);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(2_000);
				expect(sizes.at(-1)).toBeLessThan(1_500);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

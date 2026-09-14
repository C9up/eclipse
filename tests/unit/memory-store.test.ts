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

	it("does not grow without bound when every key is used once", async () => {
		vi.useFakeTimers();
		try {
			const store = new MemoryStore();
			for (let i = 0; i < 1_200; i++) await store.save(`k:${i}`, "o", 10);
			vi.advanceTimersByTime(11);
			// The sweep runs on write once the map is large; one more save is
			// enough to collect the 1200 lapsed entries.
			await store.save("trigger", "o", 1_000);
			let live = 0;
			for (let i = 0; i < 1_200; i++) {
				if (await store.exists(`k:${i}`)) live++;
			}
			expect(live).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

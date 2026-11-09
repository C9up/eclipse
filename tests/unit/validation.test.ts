import { describe, expect, it, vi } from "vitest";
import { InvalidRetryError, InvalidTtlError } from "../../src/errors.js";
import { Lock } from "../../src/Lock.js";
import { LockFactory } from "../../src/LockManager.js";
import { MemoryStore } from "../../src/stores/MemoryStore.js";
import type { RetryConfig } from "../../src/types.js";

/** A store whose key is always taken, counting every round trip. */
function busyStore() {
	const store = new MemoryStore();
	const save = vi.spyOn(store, "save").mockResolvedValue(false);
	return { store, save };
}

const invalidRetries: Array<[string, RetryConfig]> = [
	["timeout: NaN", { timeout: Number.NaN }],
	["timeout: negative", { timeout: -1 }],
	["timeout: negative string", { timeout: "-5s" }],
	["delay: NaN", { delay: Number.NaN }],
	["delay: negative", { delay: -5 }],
	["delay: Infinity", { delay: Number.POSITIVE_INFINITY }],
	// Past Node's timer ceiling a sleep is clamped to 1ms: a tight poll again.
	["delay: past the timer ceiling", { delay: "30d" }],
	["delay: null", { delay: null }],
	["attempts: NaN", { attempts: Number.NaN }],
	["attempts: 0", { attempts: 0 }],
	["attempts: negative", { attempts: -1 }],
	["attempts: fractional", { attempts: 1.5 }],
];

describe("retry option validation", () => {
	it.each(invalidRetries)(
		"acquire refuses %s before asking the store anything",
		async (_label, retry) => {
			const { store, save } = busyStore();
			const lock = new LockFactory(store).createLock("busy");
			await expect(lock.acquire({ retry })).rejects.toBeInstanceOf(
				InvalidRetryError,
			);
			expect(save).not.toHaveBeenCalled();
		},
	);

	it.each(invalidRetries)(
		"a factory refuses %s as a default where it is configured",
		(_label, retry) => {
			expect(() => new LockFactory(new MemoryStore(), { retry })).toThrow(
				InvalidRetryError,
			);
		},
	);

	it("names the option and the value it refused", async () => {
		const lock = new LockFactory(new MemoryStore()).createLock("k");
		const error = await lock
			.acquire({ retry: { timeout: Number.NaN } })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InvalidRetryError);
		if (error instanceof InvalidRetryError) {
			expect(error.code).toBe("E_ECLIPSE_INVALID_RETRY");
			expect(error.message).toContain("timeout");
			expect(error.message).toContain("NaN");
		}
	});

	it("still accepts unbounded attempts, a zero delay and timeout: 0", async () => {
		const { store, save } = busyStore();
		const lock = new LockFactory(store).createLock("busy");
		expect(
			await lock.acquire({
				retry: { attempts: Number.POSITIVE_INFINITY, delay: 0, timeout: 0 },
			}),
		).toBe(false);
		// timeout: 0 is one attempt and no wait.
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("reads timeout: Infinity or null as no deadline", async () => {
		const { store, save } = busyStore();
		const lock = new LockFactory(store).createLock("busy");
		expect(
			await lock.acquire({
				retry: { attempts: 2, delay: 0, timeout: Number.POSITIVE_INFINITY },
			}),
		).toBe(false);
		expect(
			await lock.acquire({ retry: { attempts: 2, delay: 0, timeout: null } }),
		).toBe(false);
		expect(save).toHaveBeenCalledTimes(4);
	});

	it("accepts a finite attempt count and a human-duration timeout", async () => {
		const { store, save } = busyStore();
		const lock = new LockFactory(store).createLock("busy");
		expect(
			await lock.acquire({
				retry: { attempts: 3, delay: "1ms", timeout: "1s" },
			}),
		).toBe(false);
		expect(save).toHaveBeenCalledTimes(3);
	});
});

describe("TTL bounds", () => {
	it.each([
		["1e21", 1e21],
		["10000000000000000w", "10000000000000000w"],
		["MAX_SAFE_INTEGER + 2", Number.MAX_SAFE_INTEGER + 2],
	])(
		"refuses a TTL of %s that one store would accept and another reject",
		(_label, ttl) => {
			expect(() =>
				new LockFactory(new MemoryStore()).createLock("k", ttl),
			).toThrow(InvalidTtlError);
			expect(() => new LockFactory(new MemoryStore(), { ttl })).toThrow(
				InvalidTtlError,
			);
		},
	);

	it("refuses to extend by a duration past the same bound", async () => {
		const lock = new LockFactory(new MemoryStore()).createLock("k", 1_000);
		await lock.acquireImmediately();
		await expect(lock.extend(1e21)).rejects.toBeInstanceOf(InvalidTtlError);
		await lock.release();
	});

	it("still accepts the largest safe TTL", () => {
		expect(
			new Lock(
				"k",
				new MemoryStore(),
				{
					retry: { attempts: 1, delay: 0, timeout: undefined },
					ttl: 1_000,
				},
				undefined,
				Number.MAX_SAFE_INTEGER,
			).serialize().ttl,
		).toBe(Number.MAX_SAFE_INTEGER);
	});
});

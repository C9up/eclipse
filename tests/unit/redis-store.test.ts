import { describe, expect, it, vi } from "vitest";
import { LockNotOwnedError, LockStorageError } from "../../src/errors.js";
import {
	type LockRedisClient,
	RedisStore,
} from "../../src/stores/RedisStore.js";

/**
 * The commands are asserted rather than simulated. A fake that re-implements
 * Redis would only prove the fake agrees with itself; what can actually be
 * wrong here is the argument order, the missing NX, a fractional PX, and how
 * a reply is read — which is exactly what these assert.
 */
function client(
	replies: Partial<Record<"set" | "eval" | "del" | "exists", unknown>> = {},
) {
	// Key presence, not `??`: `null` is the reply that MEANS "someone else
	// holds it", and `replies.set ?? "OK"` would quietly turn it back into a
	// successful acquisition — the fake would then never produce the case the
	// test exists to cover.
	const reply = (name: "set" | "eval" | "del" | "exists", fallback: unknown) =>
		name in replies ? replies[name] : fallback;
	return {
		set: vi.fn().mockResolvedValue(reply("set", "OK")),
		eval: vi.fn().mockResolvedValue(reply("eval", 1)),
		del: vi.fn().mockResolvedValue(reply("del", 1)),
		exists: vi.fn().mockResolvedValue(reply("exists", 1)),
	} satisfies LockRedisClient;
}

describe("RedisStore", () => {
	it("takes the lock with SET NX PX in one round trip", async () => {
		const redis = client();
		const store = new RedisStore(redis);
		expect(await store.save("k", "owner-a", 1_500)).toBe(true);
		expect(redis.set).toHaveBeenCalledWith(
			"eclipse:lock:k",
			"owner-a",
			"PX",
			1_500,
			"NX",
		);
	});

	it("rounds a fractional TTL up — Redis rejects a fractional PX outright", async () => {
		const redis = client();
		await new RedisStore(redis).save("k", "o", 100.4);
		expect(redis.set).toHaveBeenCalledWith(
			"eclipse:lock:k",
			"o",
			"PX",
			101,
			"NX",
		);
	});

	it("omits PX entirely for a lease that never expires", async () => {
		const redis = client();
		await new RedisStore(redis).save("k", "o", null);
		expect(redis.set).toHaveBeenCalledWith("eclipse:lock:k", "o", "NX");
	});

	it("reads a null reply as 'someone else holds it'", async () => {
		const store = new RedisStore(client({ set: null }));
		expect(await store.save("k", "o", 1_000)).toBe(false);
	});

	it("releases through a script that compares the owner token first", async () => {
		const redis = client({ eval: 1 });
		await new RedisStore(redis).delete("k", "owner-a");
		const [script, numKeys, key, owner] = redis.eval.mock.calls[0] ?? [];
		expect(String(script)).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
		expect(String(script)).toContain("del");
		expect(numKeys).toBe(1);
		expect(key).toBe("eclipse:lock:k");
		expect(owner).toBe("owner-a");
	});

	it("reports a release that removed nothing", async () => {
		const store = new RedisStore(client({ eval: 0 }));
		await expect(store.delete("k", "owner-a")).rejects.toBeInstanceOf(
			LockNotOwnedError,
		);
	});

	it("extends through pexpire, owner-checked, with an integer duration", async () => {
		const redis = client({ eval: 1 });
		await new RedisStore(redis).extend("k", "owner-a", 2_000.7);
		const [script, , , , duration] = redis.eval.mock.calls[0] ?? [];
		expect(String(script)).toContain("pexpire");
		expect(duration).toBe(2_001);
	});

	it("reports an extend that matched nothing", async () => {
		const store = new RedisStore(client({ eval: 0 }));
		await expect(store.extend("k", "o", 1_000)).rejects.toBeInstanceOf(
			LockNotOwnedError,
		);
	});

	it("honours a custom prefix", async () => {
		const redis = client();
		await new RedisStore(redis, { prefix: "app:locks:" }).save("k", "o", 10);
		expect(redis.set).toHaveBeenCalledWith("app:locks:k", "o", "PX", 10, "NX");
	});

	it("resolves a lazily-supplied client once, not per command", async () => {
		const redis = client();
		const resolver = vi.fn().mockResolvedValue(redis);
		const store = new RedisStore(resolver);
		await store.save("k", "o", 10);
		await store.exists("k");
		expect(resolver).toHaveBeenCalledTimes(1);
	});

	it("reports a store failure as a storage error, not a raw driver error", async () => {
		const redis = client();
		redis.set.mockRejectedValue(new Error("ECONNREFUSED"));
		const store = new RedisStore(redis);
		const error = await store.save("k", "o", 10).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LockStorageError);
		if (error instanceof LockStorageError) {
			expect(error.code).toBe("E_LOCK_STORAGE_ERROR");
			expect(error.cause).toBeInstanceOf(Error);
		}
	});

	it("does not disguise a not-owned error as a storage error", async () => {
		const store = new RedisStore(client({ eval: 0 }));
		await expect(store.delete("k", "o")).rejects.toBeInstanceOf(
			LockNotOwnedError,
		);
	});

	it("forceDelete drops the key outright, with no owner check", async () => {
		const redis = client();
		await new RedisStore(redis).forceDelete("k");
		expect(redis.del).toHaveBeenCalledWith("eclipse:lock:k");
		expect(redis.eval).not.toHaveBeenCalled();
	});

	it("reads EXISTS 0 as free", async () => {
		expect(await new RedisStore(client({ exists: 0 })).exists("k")).toBe(false);
	});
});

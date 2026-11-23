import { createHash } from "node:crypto";
import { Exception } from "@c9up/flare";
import { describe, expect, it, vi } from "vitest";
import {
	E_ECLIPSE_QUASAR_MISSING,
	E_LOCK_NOT_OWNED,
	E_LOCK_STORAGE_ERROR,
} from "../../src/errors.js";
import {
	type LockRedisClient,
	RedisStore,
} from "../../src/stores/RedisStore.js";

type Command = "set" | "evalsha" | "del" | "exists";

/**
 * The commands are asserted rather than simulated. A fake that re-implements
 * Redis would only prove the fake agrees with itself; what can actually be
 * wrong here is the argument order, the missing NX, a fractional PX, and how
 * a reply is read — which is exactly what these assert.
 *
 * The one piece of server state kept is the script cache, because the store's
 * behaviour depends on it: EVALSHA of a script Redis was never handed answers
 * NOSCRIPT, as a real server does after a restart or SCRIPT FLUSH.
 */
function client(replies: Partial<Record<Command, unknown>> = {}) {
	// Key presence, not `??`: `null` is the reply that MEANS "someone else
	// holds it", and `replies.set ?? "OK"` would quietly turn it back into a
	// successful acquisition — the fake would then never produce the case the
	// test exists to cover.
	const reply = (name: Command, fallback: unknown) =>
		name in replies ? replies[name] : fallback;
	const scripts = new Map<string, string>();
	const commands = {
		set: vi.fn().mockResolvedValue(reply("set", "OK")),
		evalsha: vi.fn(async (sha: string) => {
			if (!scripts.has(sha)) throw new Error("NOSCRIPT No matching script");
			return reply("evalsha", 1);
		}),
		script: vi.fn(async (subcommand: "LOAD", lua: string) => {
			if (subcommand !== "LOAD") throw new Error("ERR unknown subcommand");
			const sha = sha1(lua);
			scripts.set(sha, lua);
			return sha;
		}),
		del: vi.fn().mockResolvedValue(reply("del", 1)),
		exists: vi.fn().mockResolvedValue(reply("exists", 1)),
	} satisfies LockRedisClient;
	return { ...commands, scripts };
}

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
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
		const redis = client({ evalsha: 1 });
		await new RedisStore(redis).delete("k", "owner-a");
		const [, script = ""] = redis.script.mock.calls[0] ?? [];
		expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
		expect(script).toContain("del");
		expect(redis.evalsha).toHaveBeenLastCalledWith(
			sha1(script),
			1,
			"eclipse:lock:k",
			"owner-a",
		);
	});

	it("loads a script the first time Redis does not know it, then runs it by SHA1 only", async () => {
		const redis = client({ evalsha: 1 });
		const store = new RedisStore(redis);

		await store.delete("k", "owner-a");
		// NOSCRIPT, SCRIPT LOAD, then EVALSHA again — in that order.
		expect(redis.evalsha).toHaveBeenCalledTimes(2);
		expect(redis.script).toHaveBeenCalledOnce();
		const [loadOrder] = redis.script.mock.invocationCallOrder;
		const [firstRun, secondRun] = redis.evalsha.mock.invocationCallOrder;
		expect(firstRun).toBeLessThan(loadOrder ?? 0);
		expect(loadOrder).toBeLessThan(secondRun ?? 0);

		await store.delete("k", "owner-a");
		await store.delete("other", "owner-b");
		expect(redis.evalsha).toHaveBeenCalledTimes(4);
		expect(redis.script).toHaveBeenCalledOnce();
	});

	it("loads the script again after Redis lost its script cache", async () => {
		const redis = client({ evalsha: 1 });
		const store = new RedisStore(redis);
		await store.extend("k", "o", 1_000);
		// A restart or SCRIPT FLUSH empties the cache under a live client.
		redis.scripts.clear();
		await store.extend("k", "o", 1_000);
		expect(redis.script).toHaveBeenCalledTimes(2);
	});

	it("does not retry a script that failed with anything but NOSCRIPT", async () => {
		const redis = client();
		const failure = new Error("BUSY Redis is busy running a script");
		redis.evalsha.mockRejectedValueOnce(failure);
		const error = await new RedisStore(redis)
			.delete("k", "o")
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E_LOCK_STORAGE_ERROR);
		if (error instanceof E_LOCK_STORAGE_ERROR)
			expect(error.cause).toBe(failure);
		expect(redis.evalsha).toHaveBeenCalledOnce();
		expect(redis.script).not.toHaveBeenCalled();
	});

	it("reports a release that removed nothing", async () => {
		const store = new RedisStore(client({ evalsha: 0 }));
		await expect(store.delete("k", "owner-a")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
	});

	it("extends through pexpire, owner-checked, with an integer duration", async () => {
		const redis = client({ evalsha: 1 });
		await new RedisStore(redis).extend("k", "owner-a", 2_000.7);
		const [, script = ""] = redis.script.mock.calls[0] ?? [];
		expect(script).toContain("pexpire");
		expect(redis.evalsha).toHaveBeenLastCalledWith(
			sha1(script),
			1,
			"eclipse:lock:k",
			"owner-a",
			2_001,
		);
	});

	it("reports an extend that matched nothing", async () => {
		const store = new RedisStore(client({ evalsha: 0 }));
		await expect(store.extend("k", "o", 1_000)).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
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

	// Quasar retires a connection whose retry strategy gave up and hands out a
	// fresh one. Keeping the dead client made every lock fail with
	// E_LOCK_STORAGE_ERROR, and every scheduled task skip, until restart.
	it("resolves again once the client it kept has ended for good", async () => {
		const first = { ...client(), status: "ready" };
		const second = { ...client(), status: "ready" };
		const resolver = vi
			.fn<() => LockRedisClient>()
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const store = new RedisStore(resolver);

		await store.exists("k");
		first.status = "end";
		await store.exists("k");
		await store.exists("k");

		expect(resolver).toHaveBeenCalledTimes(2);
		expect(first.exists).toHaveBeenCalledOnce();
		expect(second.exists).toHaveBeenCalledTimes(2);
	});

	it("keeps a client that closed but reconnects by itself, and one handed in directly", async () => {
		const resolved = { ...client(), status: "ready" };
		const resolver = vi.fn(() => resolved);
		const store = new RedisStore(resolver);
		await store.exists("k");
		resolved.status = "close";
		await store.exists("k");
		expect(resolver).toHaveBeenCalledOnce();

		const direct = { ...client(), status: "end" };
		await new RedisStore(direct).exists("k");
		expect(direct.exists).toHaveBeenCalledOnce();
	});

	it("retries a resolver that failed, instead of caching the failure for good", async () => {
		const redis = client();
		let calls = 0;
		const store = new RedisStore(async () => {
			calls++;
			if (calls === 1) throw new Error("connection 'main' not registered yet");
			return redis;
		});
		await expect(store.save("k", "o", 10)).rejects.toBeInstanceOf(
			E_LOCK_STORAGE_ERROR,
		);
		expect(await store.save("k", "o", 10)).toBe(true);
		await store.exists("k");
		// Kept once it succeeded.
		expect(calls).toBe(2);
	});

	it("fails every command waiting on the same failed resolution, then retries", async () => {
		const redis = client();
		let calls = 0;
		let fail = true;
		const store = new RedisStore(async () => {
			calls++;
			await Promise.resolve();
			if (fail) throw new Error("not yet");
			return redis;
		});
		const results = await Promise.allSettled([
			store.save("a", "o", 10),
			store.save("b", "o", 10),
		]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		// Concurrent commands share one resolution rather than racing N of them.
		expect(calls).toBe(1);
		fail = false;
		expect(await store.save("a", "o", 10)).toBe(true);
		expect(calls).toBe(2);
	});

	it("lets a configuration error from the resolver keep its own code", async () => {
		const store = new RedisStore(async () => {
			throw new E_ECLIPSE_QUASAR_MISSING(["not installed"]);
		});
		const error = await store.save("k", "o", 10).catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(E_LOCK_STORAGE_ERROR);
		expect(error).toBeInstanceOf(Exception);
		if (error instanceof Exception) {
			expect(error.code).toBe("E_ECLIPSE_QUASAR_MISSING");
		}
	});

	it("reports a store failure as a storage error, not a raw driver error", async () => {
		const redis = client();
		redis.set.mockRejectedValue(new Error("ECONNREFUSED"));
		const store = new RedisStore(redis);
		const error = await store.save("k", "o", 10).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(E_LOCK_STORAGE_ERROR);
		if (error instanceof E_LOCK_STORAGE_ERROR) {
			expect(error.code).toBe("E_LOCK_STORAGE_ERROR");
			expect(error.message).toBe("Lock storage error: ECONNREFUSED");
			expect(error.operation).toBe("save");
			expect(error.cause).toBeInstanceOf(Error);
		}
	});

	it("does not disguise a not-owned error as a storage error", async () => {
		const store = new RedisStore(client({ evalsha: 0 }));
		await expect(store.delete("k", "o")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
	});

	it("forceDelete drops the key outright, with no owner check", async () => {
		const redis = client();
		await new RedisStore(redis).forceDelete("k");
		expect(redis.del).toHaveBeenCalledWith("eclipse:lock:k");
		expect(redis.evalsha).not.toHaveBeenCalled();
	});

	it("reads EXISTS 0 as free", async () => {
		expect(await new RedisStore(client({ exists: 0 })).exists("k")).toBe(false);
	});
});

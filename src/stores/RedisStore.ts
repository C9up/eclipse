/**
 * Redis lock store — the one a second replica needs.
 *
 * Without a shared store every instance takes every lock: a nightly invoice
 * run goes out N times, a reminder arrives N times, and nothing in the logs
 * says so.
 *
 * No import of a Redis package. The client is taken structurally — `set`,
 * `evalsha`, `script`, `del`, `exists` — so this works against a
 * `@c9up/quasar` connection without eclipse depending on quasar, which is an
 * optional peer.
 */

import { createHash } from "node:crypto";
import { E_LOCK_NOT_OWNED, E_LOCK_STORAGE_ERROR } from "../errors.js";
import { isEclipseError, reasonOf } from "../isEclipseError.js";
import type { LockStore } from "../types.js";
import { hasEnded } from "../vendor/quasarConnection.js";

/**
 * The commands this store issues. Any client answering them will do.
 *
 * The owner-checked release and extend run as Lua scripts through EVALSHA,
 * loaded with SCRIPT LOAD the first time Redis does not know them, so a client
 * must answer both — EVAL alone is no longer enough. Supply-chain scanners
 * report a `.eval` method call as dynamic code execution, and EVALSHA also
 * saves resending the script body on every release.
 */
export interface LockRedisClient {
	/** `SET key value [PX ttl] NX` — answers null when the key already exists. */
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	/** `EVALSHA sha1 numKeys ...` — runs a script Redis already holds. */
	evalsha(sha1: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
	/** `SCRIPT LOAD script` — hands Redis a script so EVALSHA can run it. */
	script(subcommand: "LOAD", script: string): Promise<unknown>;
	del(key: string): Promise<unknown>;
	exists(key: string): Promise<unknown>;
}

/**
 * How the store gets its client: the client itself, or something that answers
 * with one.
 *
 * The resolver form is what a config file needs. `config/lock.ts` is read
 * before the application boots, so the connection does not exist yet and
 * cannot be awaited there — a function defers the lookup to the first lock.
 */
export type LockRedisResolver =
	| LockRedisClient
	| (() => LockRedisClient | Promise<LockRedisClient>);

export interface RedisStoreOptions {
	/** Key prefix. Default `"eclipse:lock:"`. */
	prefix?: string;
}

/**
 * Release only a lease we still hold.
 *
 * A plain `DEL` is the classic way to break this: work that outlives its TTL
 * loses the lock, another instance acquires it and starts running, and the
 * first one then deletes THAT instance's lease on its way out — leaving the
 * name free while work is still running under it. Comparing the token before
 * deleting makes the release a no-op once the lease is no longer ours.
 */
const RELEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** Extend only a lease we still hold, for the same reason. */
const EXTEND = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/** A Lua script and the SHA1 Redis knows it by. */
interface LuaScript {
	readonly lua: string;
	readonly sha: string;
}

function luaScript(lua: string): LuaScript {
	return { lua, sha: createHash("sha1").update(lua).digest("hex") };
}

const RELEASE_SCRIPT = luaScript(RELEASE);
const EXTEND_SCRIPT = luaScript(EXTEND);

function isNoScript(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

export class RedisStore implements LockStore {
	readonly #source: LockRedisResolver;
	readonly #prefix: string;
	#resolved: Promise<LockRedisClient> | undefined;
	/** What {@link #resolved} settled to, so its state can be read. */
	#settled: LockRedisClient | undefined;

	constructor(client: LockRedisResolver, options: RedisStoreOptions = {}) {
		this.#source = client;
		this.#prefix = options.prefix ?? "eclipse:lock:";
	}

	/**
	 * The client, resolved once and kept — once it SUCCEEDED.
	 *
	 * A failed resolution is forgotten, so the next command asks again: a lock
	 * taken before the connection is registered, or during a transient import
	 * failure, must not disable every lock until the process restarts.
	 * Commands issued while one resolution is pending share it.
	 *
	 * A resolved client that has ended for good is forgotten too: quasar
	 * retires a connection whose retry strategy gave up and hands out a fresh
	 * one, and keeping the dead client failed every lock — and skipped every
	 * scheduled task — until restart. NAMED DEVIATION, better than upstream,
	 * whose lock store captures `ioConnection` once. A client handed in
	 * directly is kept whatever its state.
	 */
	#client(): Promise<LockRedisClient> {
		if (typeof this.#source === "function" && hasEnded(this.#settled)) {
			this.#resolved = undefined;
			this.#settled = undefined;
		}
		if (this.#resolved === undefined) {
			const source = this.#source;
			const pending = Promise.resolve()
				.then(() => (typeof source === "function" ? source() : source))
				.then((client) => {
					if (this.#resolved === pending) this.#settled = client;
					return client;
				});
			this.#resolved = pending;
			pending.catch(() => {
				if (this.#resolved === pending) this.#resolved = undefined;
			});
		}
		return this.#resolved;
	}

	#key(key: string): string {
		return `${this.#prefix}${key}`;
	}

	/**
	 * Run a script by its SHA1, loading it first if Redis does not know it.
	 *
	 * A NOSCRIPT reply means the script did not run at all — Redis restarted,
	 * failed over, or had its script cache flushed — so loading it and running
	 * it again cannot apply the release or extend twice. Any other error is
	 * rethrown untouched: the script may have run, and retrying it is not
	 * this helper's call.
	 */
	async #runScript(
		client: LockRedisClient,
		script: LuaScript,
		key: string,
		...args: unknown[]
	): Promise<unknown> {
		try {
			return await client.evalsha(script.sha, 1, key, ...args);
		} catch (error) {
			if (!isNoScript(error)) throw error;
			await client.script("LOAD", script.lua);
			return client.evalsha(script.sha, 1, key, ...args);
		}
	}

	/**
	 * Every command goes through here so a store failure is reported as one.
	 *
	 * A raw ioredis error surfacing from `lock.run()` reads as an application
	 * bug; `E_LOCK_STORAGE_ERROR` says the lock layer could not reach its
	 * store, which is the fact the caller needs to decide whether to proceed
	 * unlocked or fail. An eclipse error already says what went wrong — a lost
	 * lease, or a resolver reporting a missing quasar — and keeps its code.
	 */
	async #issue<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (cause) {
			if (isEclipseError(cause)) throw cause;
			throw new E_LOCK_STORAGE_ERROR([reasonOf(cause)], {
				cause: cause,
				operation,
			});
		}
	}

	/**
	 * `SET key owner PX ttl NX` — one round trip, atomic on the server, which
	 * is what makes the decision the same for every instance asking at once.
	 *
	 * The TTL is what recovers the lock after a crash: an instance that dies
	 * holding it never releases, and the lease simply expires. A `null` ttl
	 * omits `PX` entirely — a lease that outlives every crash, which is why
	 * {@link forceDelete} exists.
	 */
	save(key: string, owner: string, ttl: number | null): Promise<boolean> {
		return this.#issue("save", async () => {
			const client = await this.#client();
			// Redis takes an integer number of milliseconds; a fractional TTL is
			// a protocol error, not a rounding detail.
			const result =
				ttl === null
					? await client.set(this.#key(key), owner, "NX")
					: await client.set(this.#key(key), owner, "PX", Math.ceil(ttl), "NX");
			return result !== null && result !== undefined;
		});
	}

	delete(key: string, owner: string): Promise<void> {
		return this.#issue("delete", async () => {
			const client = await this.#client();
			const removed = await this.#runScript(
				client,
				RELEASE_SCRIPT,
				this.#key(key),
				owner,
			);
			// Zero means the key is gone or belongs to someone else. Gone is not
			// an error — the lease simply lapsed after the work was done — but
			// eclipse cannot tell the two apart from this reply alone, and the
			// safe reading of "I could not release what I thought I held" is to
			// say so.
			if (Number(removed) === 0) throw new E_LOCK_NOT_OWNED(undefined, { key });
		});
	}

	forceDelete(key: string): Promise<void> {
		return this.#issue("forceDelete", async () => {
			const client = await this.#client();
			await client.del(this.#key(key));
		});
	}

	exists(key: string): Promise<boolean> {
		return this.#issue("exists", async () => {
			const client = await this.#client();
			return Number(await client.exists(this.#key(key))) > 0;
		});
	}

	extend(key: string, owner: string, duration: number): Promise<void> {
		return this.#issue("extend", async () => {
			const client = await this.#client();
			const extended = await this.#runScript(
				client,
				EXTEND_SCRIPT,
				this.#key(key),
				owner,
				Math.ceil(duration),
			);
			if (Number(extended) === 0)
				throw new E_LOCK_NOT_OWNED(undefined, { key });
		});
	}
}

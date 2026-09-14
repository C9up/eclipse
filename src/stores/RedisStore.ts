/**
 * Redis lock store — the one a second replica needs.
 *
 * Without a shared store every instance takes every lock: a nightly invoice
 * run goes out N times, a reminder arrives N times, and nothing in the logs
 * says so.
 *
 * No import of a Redis package. The client is taken structurally — `set`,
 * `eval`, `del`, `exists` — so this works against a `@c9up/quasar` connection
 * without eclipse depending on quasar, which is an optional peer.
 */

import { LockNotOwnedError, LockStorageError } from "../errors.js";
import type { LockStore } from "../types.js";

/** The commands this store issues. Any client answering them will do. */
export interface LockRedisClient {
	/** `SET key value [PX ttl] NX` — answers null when the key already exists. */
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	/** `EVAL script numKeys ...` — the owner-checked release and extend. */
	eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
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

export class RedisStore implements LockStore {
	readonly #source: LockRedisResolver;
	readonly #prefix: string;
	#resolved: Promise<LockRedisClient> | undefined;

	constructor(client: LockRedisResolver, options: RedisStoreOptions = {}) {
		this.#source = client;
		this.#prefix = options.prefix ?? "eclipse:lock:";
	}

	/** The client, resolved once and kept. */
	#client(): Promise<LockRedisClient> {
		this.#resolved ??= Promise.resolve(
			typeof this.#source === "function" ? this.#source() : this.#source,
		);
		return this.#resolved;
	}

	#key(key: string): string {
		return `${this.#prefix}${key}`;
	}

	/**
	 * Every command goes through here so a store failure is reported as one.
	 *
	 * A raw ioredis error surfacing from `lock.run()` reads as an application
	 * bug; `E_LOCK_STORAGE_ERROR` says the lock layer could not reach its
	 * store, which is the fact the caller needs to decide whether to proceed
	 * unlocked or fail.
	 */
	async #issue<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (cause) {
			if (cause instanceof LockNotOwnedError) throw cause;
			throw new LockStorageError(operation, cause);
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
			const removed = await client.eval(RELEASE, 1, this.#key(key), owner);
			// Zero means the key is gone or belongs to someone else. Gone is not
			// an error — the lease simply lapsed after the work was done — but
			// eclipse cannot tell the two apart from this reply alone, and the
			// safe reading of "I could not release what I thought I held" is to
			// say so. `Lock.run` absorbs it; a direct `release()` reports it.
			if (Number(removed) === 0) throw new LockNotOwnedError(key);
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
			const extended = await client.eval(
				EXTEND,
				1,
				this.#key(key),
				owner,
				Math.ceil(duration),
			);
			if (Number(extended) === 0) throw new LockNotOwnedError(key);
		});
	}
}

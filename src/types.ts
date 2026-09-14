/**
 * Shared lock contracts — the store interface, the retry policy, and the
 * serialized shape a lock takes when it crosses a process boundary.
 */

import type { Duration } from "./duration.js";

/**
 * A lock store.
 *
 * Every method is owner-aware except {@link LockStore.forceDelete} and
 * {@link LockStore.exists}. That is the whole point: the store is the only
 * layer that can make "release only if it is still mine" atomic, and a store
 * that checked ownership in the caller instead would race with expiry.
 */
export interface LockStore {
	/**
	 * Take the lock for `owner`, for `ttl` milliseconds — or forever when
	 * `ttl` is `null`.
	 *
	 * Must be atomic against concurrent callers: two instances asking at the
	 * same instant must not both be told yes. Must treat an entry whose TTL
	 * has elapsed as free, so a holder that crashed mid-work recovers without
	 * anyone cleaning up.
	 *
	 * @returns `true` when the caller now holds it, `false` when someone else does.
	 */
	save(key: string, owner: string, ttl: number | null): Promise<boolean>;

	/**
	 * Release the lock, but only if `owner` still holds it.
	 *
	 * @throws {import("./errors.js").LockNotOwnedError} when it does not.
	 */
	delete(key: string, owner: string): Promise<void>;

	/** Release the lock whoever holds it. The break-glass path. */
	forceDelete(key: string): Promise<void>;

	/** Whether the lock is currently held by anyone. */
	exists(key: string): Promise<boolean>;

	/**
	 * Push the expiry out by `duration` milliseconds from now, if `owner`
	 * still holds it.
	 *
	 * @throws {import("./errors.js").LockNotOwnedError} when it does not.
	 */
	extend(key: string, owner: string, duration: number): Promise<void>;

	/**
	 * Release what this store OWNS — a timer, a connection it opened.
	 *
	 * A store handed an existing client must not implement it: closing a
	 * connection eclipse did not open would break whoever else is on it.
	 */
	disconnect?(): Promise<void>;
}

/** How a blocking {@link Lock.acquire} retries while the lock is held. */
export interface RetryConfig {
	/**
	 * How many times to ask before giving up.
	 *
	 * Default `Number.POSITIVE_INFINITY` — matching upstream, where an
	 * `acquire()` without options waits as long as it takes. Pair it with
	 * `timeout` when the caller has a deadline.
	 */
	attempts?: number;
	/** How long to wait between attempts. Default `250ms`. */
	delay?: Duration;
	/**
	 * Total wall-clock budget before giving up, regardless of `attempts`.
	 *
	 * Default `undefined` — no deadline.
	 */
	timeout?: Duration;
}

/** Options for {@link Lock.acquire}. */
export interface LockAcquireOptions {
	retry?: RetryConfig;
}

/** Defaults a {@link LockFactory} applies to every lock it creates. */
export interface LockFactoryOptions {
	retry?: RetryConfig;
	/** Lease length used when `createLock` does not name one. Default `30s`. */
	ttl?: Duration;
}

/** {@link LockFactoryOptions} with everything filled in. */
export interface ResolvedLockConfig {
	retry: {
		attempts: number;
		delay: number;
		timeout: number | undefined;
	};
	ttl: number | null;
}

/**
 * A lock flattened to data, so one process can hand a held lease to another —
 * a job enqueued by the request that took the lock, released by the worker
 * that finishes it.
 */
export interface SerializedLock {
	key: string;
	owner: string;
	ttl: number | null;
	expirationTime: number | null;
}

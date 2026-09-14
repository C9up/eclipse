/**
 * A single named lease.
 *
 * A lock is cheap to create and holds no resources: it is a key, an owner
 * token, and the store it talks to. Nothing happens until `acquire()`.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type Duration, resolveMs } from "./duration.js";
import { InvalidTtlError, LockNotOwnedError } from "./errors.js";
import type {
	LockAcquireOptions,
	LockStore,
	ResolvedLockConfig,
	SerializedLock,
} from "./types.js";

/**
 * Reject a TTL that cannot bound anything.
 *
 * A zero or negative lease expires the instant it is taken, so every instance
 * acquires the same lock and runs the same work — the exact outcome locking
 * exists to prevent, arriving silently.
 */
export function assertValidTtl(ttl: number | null): void {
	if (ttl === null) return;
	if (!Number.isFinite(ttl) || ttl <= 0) throw new InvalidTtlError(ttl);
}

export class Lock {
	readonly #key: string;
	readonly #store: LockStore;
	readonly #config: ResolvedLockConfig;
	readonly #owner: string;
	readonly #ttl: number | null;
	#expirationTime: number | null;

	constructor(
		key: string,
		store: LockStore,
		config: ResolvedLockConfig,
		owner?: string,
		ttl?: number | null,
		expirationTime: number | null = null,
	) {
		const lease = ttl === undefined ? config.ttl : ttl;
		assertValidTtl(lease);
		this.#key = key;
		this.#store = store;
		this.#config = config;
		this.#owner = owner ?? randomUUID();
		this.#ttl = lease;
		this.#expirationTime = expirationTime;
	}

	/** The key this leases. */
	getKey(): string {
		return this.#key;
	}

	/**
	 * The owner token.
	 *
	 * Random per lock unless one was supplied. It is what makes a release
	 * safe: the store compares it before deleting, so a holder whose lease has
	 * already expired cannot remove the lease another holder has since taken.
	 */
	getOwner(): string {
		return this.#owner;
	}

	/** Flatten to data, so another process can hold the same lease. */
	serialize(): SerializedLock {
		return {
			key: this.#key,
			owner: this.#owner,
			ttl: this.#ttl,
			expirationTime: this.#expirationTime,
		};
	}

	/** Whether this lease is past its expiry. A never-expiring lock is never expired. */
	isExpired(): boolean {
		if (this.#expirationTime === null) return false;
		return Date.now() > this.#expirationTime;
	}

	/**
	 * Milliseconds left on this lease, `null` when it never expires.
	 *
	 * Clamped at zero: a negative number reads as a duration and would be
	 * passed straight back into an `extend()` that then rejects it.
	 */
	getRemainingTime(): number | null {
		if (this.#expirationTime === null) return null;
		return Math.max(0, this.#expirationTime - Date.now());
	}

	/** Whether the key is held by anyone at all — not necessarily by us. */
	isLocked(): Promise<boolean> {
		return this.#store.exists(this.#key);
	}

	/**
	 * Take the lock, waiting while someone else holds it.
	 *
	 * This is the form a cache stampede needs: the caller that loses the race
	 * wants to WAIT for the winner to finish and then read what it wrote, not
	 * to fail. Bound it with `retry.timeout` whenever the caller has a
	 * deadline of its own — the default waits indefinitely, matching upstream.
	 *
	 * @returns `true` once held, `false` when it gave up.
	 */
	async acquire(options: LockAcquireOptions = {}): Promise<boolean> {
		this.#expirationTime = null;
		const maxAttempts = options.retry?.attempts ?? this.#config.retry.attempts;
		const delay =
			resolveMs(options.retry?.delay, this.#config.retry.delay) ?? 0;
		const timeout =
			resolveMs(options.retry?.timeout, this.#config.retry.timeout ?? null) ??
			undefined;
		const start = Date.now();

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const now = Date.now();
			if (await this.#store.save(this.#key, this.#owner, this.#ttl)) {
				this.#expirationTime = this.#ttl === null ? null : now + this.#ttl;
				return true;
			}
			if (attempt === maxAttempts) return false;

			// NAMED DEVIATION from upstream, which checks the elapsed budget only
			// AFTER a failed attempt and then always sleeps the full delay — so a
			// 100ms timeout with a 250ms delay overshoots to 250ms before
			// reporting. Here the deadline is checked BEFORE sleeping and the
			// sleep is clipped to what is left, which is what a caller passing a
			// timeout asked for. `timeout` is compared against `undefined` rather
			// than for truthiness, so `timeout: 0` means "do not wait" instead of
			// "wait forever".
			if (timeout !== undefined) {
				const remaining = timeout - (Date.now() - start);
				if (remaining <= 0) return false;
				await sleep(Math.min(delay, remaining));
			} else {
				await sleep(delay);
			}
		}
		return false;
	}

	/**
	 * Take the lock if it is free right now, and report rather than wait.
	 *
	 * This is what a scheduler wants: on each tick exactly one instance should
	 * run the task and the others should do nothing at all, not queue up
	 * behind it.
	 */
	async acquireImmediately(): Promise<boolean> {
		const now = Date.now();
		if (!(await this.#store.save(this.#key, this.#owner, this.#ttl))) {
			return false;
		}
		this.#expirationTime = this.#ttl === null ? null : now + this.#ttl;
		return true;
	}

	/**
	 * Acquire, run, release — the form almost every caller wants.
	 *
	 * @returns `[true, result]` when it ran, `[false, null]` when the lock
	 *   could not be taken. The tuple is upstream's shape, and it is what lets
	 *   a caller tell "ran and returned undefined" from "never ran".
	 */
	async run<T>(callback: () => Promise<T>): Promise<[true, T] | [false, null]> {
		if (!(await this.acquire())) return [false, null];
		try {
			return [true, await callback()];
		} finally {
			await this.#releaseAfterWork();
		}
	}

	/** {@link run}, but without waiting for a lock someone else holds. */
	async runImmediately<T>(
		callback: () => Promise<T>,
	): Promise<[true, T] | [false, null]> {
		if (!(await this.acquireImmediately())) return [false, null];
		try {
			return [true, await callback()];
		} finally {
			await this.#releaseAfterWork();
		}
	}

	/**
	 * Release on the way out of `run`.
	 *
	 * NAMED DEVIATION from upstream, which calls `release()` directly in the
	 * `finally`. Work that outlives its own TTL loses the lease, and releasing
	 * it then raises — from a `finally`, which REPLACES whatever the callback
	 * was throwing. The original failure disappears and the caller is told the
	 * lock was not owned, which is the less useful of the two facts and points
	 * at the wrong line.
	 *
	 * Losing the lease mid-work is still a real problem; it is just not this
	 * method's to report. Give long work a TTL that covers it, or call
	 * {@link extend} while it runs.
	 */
	async #releaseAfterWork(): Promise<void> {
		try {
			await this.release();
		} catch (error) {
			if (error instanceof LockNotOwnedError) return;
			throw error;
		}
	}

	/**
	 * Release the lease.
	 *
	 * @throws {LockNotOwnedError} when this holder no longer owns it.
	 */
	async release(): Promise<void> {
		await this.#store.delete(this.#key, this.#owner);
		this.#expirationTime = null;
	}

	/** Release whoever holds it. The break-glass path for a stuck lease. */
	async forceRelease(): Promise<void> {
		await this.#store.forceDelete(this.#key);
		this.#expirationTime = null;
	}

	/**
	 * Push the expiry out, from now.
	 *
	 * What long work uses instead of taking a TTL long enough to cover its
	 * worst case — a lease sized for the worst case is also how long the lock
	 * stays stuck after a crash.
	 *
	 * @throws {LockNotOwnedError} when this holder no longer owns it.
	 */
	async extend(duration?: Duration): Promise<void> {
		const ms = resolveMs(duration, this.#ttl);
		if (ms === null || !Number.isFinite(ms) || ms <= 0) {
			throw new InvalidTtlError(ms);
		}
		await this.#store.extend(this.#key, this.#owner, ms);
		this.#expirationTime = Date.now() + ms;
	}
}

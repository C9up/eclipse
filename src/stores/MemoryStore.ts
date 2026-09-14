/**
 * In-process lock store.
 *
 * Correct while the application runs in ONE process — a single dev server, a
 * test run, a worker that is deliberately a singleton. It is not a
 * distributed lock: a second replica keeps its own map and both will happily
 * take the same key. That is the whole reason {@link RedisStore} exists, and
 * why a config that names this store in production is worth a second look.
 */

import { LockNotOwnedError } from "../errors.js";
import type { LockStore } from "../types.js";

interface Entry {
	owner: string;
	/** Epoch-ms expiry, or `null` for a lease that never expires. */
	expiresAt: number | null;
}

/**
 * How many entries may accumulate before a save also sweeps the expired ones.
 *
 * There is no timer here on purpose: a store that owns one keeps the process
 * alive and has to be shut down, and every package in the cohort has left one
 * behind at least once. Sweeping on write instead costs nothing until the map
 * is actually large, and bounds a workload that locks per user or per job id —
 * where lazy expiry alone would keep every key ever seen.
 */
const SWEEP_THRESHOLD = 1_000;

export class MemoryStore implements LockStore {
	readonly #entries = new Map<string, Entry>();

	/** The live entry for `key`, treating an elapsed lease as absent. */
	#live(key: string): Entry | undefined {
		const entry = this.#entries.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
			this.#entries.delete(key);
			return undefined;
		}
		return entry;
	}

	#sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.#entries) {
			if (entry.expiresAt !== null && now > entry.expiresAt) {
				this.#entries.delete(key);
			}
		}
	}

	save(key: string, owner: string, ttl: number | null): Promise<boolean> {
		if (this.#entries.size >= SWEEP_THRESHOLD) this.#sweep();
		if (this.#live(key) !== undefined) return Promise.resolve(false);
		this.#entries.set(key, {
			owner,
			expiresAt: ttl === null ? null : Date.now() + ttl,
		});
		return Promise.resolve(true);
	}

	delete(key: string, owner: string): Promise<void> {
		const entry = this.#live(key);
		// An absent lease raises, exactly as a held-by-someone-else one does.
		//
		// NAMED DEVIATION from upstream (@verrou/core 0.5.2), whose two drivers
		// disagree with each other on exactly this: its memory store returns
		// quietly when the entry is gone (`if (!mutex || !mutex.releaser)
		// return`), while its Redis store throws, because the Lua release
		// answers `0` for "absent" and "not yours" alike. The same release
		// therefore succeeds in a dev test run and raises in production.
		//
		// Unified here on the strict reading, not the lenient one: both cases
		// mean the caller no longer holds what it thought it held, and work
		// that ran past its own lease may have overlapped another holder. That
		// is worth reporting, not swallowing. `Lock.run` absorbs it so the
		// ergonomic path stays quiet; a direct `release()` reports it.
		if (entry === undefined || entry.owner !== owner) {
			return Promise.reject(new LockNotOwnedError(key));
		}
		this.#entries.delete(key);
		return Promise.resolve();
	}

	forceDelete(key: string): Promise<void> {
		this.#entries.delete(key);
		return Promise.resolve();
	}

	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.#live(key) !== undefined);
	}

	extend(key: string, owner: string, duration: number): Promise<void> {
		const entry = this.#live(key);
		if (entry === undefined || entry.owner !== owner) {
			return Promise.reject(new LockNotOwnedError(key));
		}
		entry.expiresAt = Date.now() + duration;
		return Promise.resolve();
	}
}

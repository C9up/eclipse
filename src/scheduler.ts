/**
 * Adapter to the narrow lock contract ream's scheduler consumes.
 *
 * The dependency points THIS way on purpose. ream's scheduler declares its own
 * two-method `LockBackend` and knows nothing about eclipse; eclipse knows the
 * shape and satisfies it. So the core keeps working with no lock package
 * installed, and an application that wants one distributed lock layer for both
 * its scheduler and its own code configures it here.
 *
 *   // config/scheduler.ts
 *   import { defineConfig } from "@c9up/ream/scheduler/config"
 *   import locks from "@c9up/eclipse/services/main"
 *   import { schedulerBackend } from "@c9up/eclipse/scheduler"
 *
 *   export default defineConfig({
 *     lock: schedulerBackend(() => locks),
 *   })
 *
 * The scheduler's own `locks.memory()` / `locks.redis()` helpers still work
 * and are what an application with no lock package installed uses. This is
 * for the application that wants ONE lock layer behind both its schedule and
 * its own code, rather than two that expire independently.
 */

import type { Duration } from "./duration.js";
import { LockNotOwnedError } from "./errors.js";
import type { Lock } from "./Lock.js";
import type { LockManager } from "./LockManager.js";

/**
 * The slice of the scheduler's contract this satisfies.
 *
 * Declared here rather than imported: importing it would make `@c9up/ream` a
 * real dependency of eclipse, and the whole point is that neither package
 * needs the other to be installed.
 */
export interface SchedulerLockBackend {
	acquire(name: string, ttlMs: number): Promise<boolean>;
	release(name: string): Promise<void>;
}

export interface SchedulerBackendOptions {
	/** Store to lease from. Defaults to the manager's default store. */
	store?: string;
	/**
	 * Key prefix, so scheduler leases cannot collide with application ones.
	 * Default `"schedule:"`.
	 */
	prefix?: string;
	/** Lease length when the scheduler does not pass one. */
	ttl?: Duration;
}

/**
 * A backend the scheduler can use, over an eclipse manager.
 *
 * The manager is taken as a thunk because `config/scheduler.ts` is read before
 * the application boots — the manager does not exist yet at that point, and
 * cannot be awaited there.
 */
export function schedulerBackend(
	manager: LockManager | (() => LockManager),
	options: SchedulerBackendOptions = {},
): SchedulerLockBackend {
	const prefix = options.prefix ?? "schedule:";
	/**
	 * The lock per held name, so `release(name)` can prove the lease is ours.
	 *
	 * The scheduler's contract releases BY NAME and carries no handle, so the
	 * owner token has to be remembered here — that token is the only thing
	 * stopping an instance whose lease already lapsed from releasing the lease
	 * a different instance has since taken.
	 */
	const held = new Map<string, Lock>();
	const resolve = (): LockManager =>
		typeof manager === "function" ? manager() : manager;

	return {
		async acquire(name: string, ttlMs: number): Promise<boolean> {
			const lock = resolve()
				.use(options.store)
				.createLock(`${prefix}${name}`, ttlMs ?? options.ttl);
			// Immediately, never blocking: on each tick exactly one instance
			// should run the task and the rest should do nothing at all, not
			// queue up behind it and run it again a moment later.
			if (!(await lock.acquireImmediately())) return false;
			held.set(name, lock);
			return true;
		},

		async release(name: string): Promise<void> {
			const lock = held.get(name);
			// Idempotent, as the scheduler's contract requires: releasing a name
			// this instance never acquired does nothing.
			if (lock === undefined) return;
			held.delete(name);
			try {
				await lock.release();
			} catch (error) {
				// A task that outlived its lease no longer owns it. The scheduler
				// calls this from a `finally`, so raising here would replace
				// whatever the task itself was reporting.
				if (error instanceof LockNotOwnedError) return;
				throw error;
			}
		},
	};
}

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

import { type Duration, resolveMs } from "./duration.js";
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
	/**
	 * Lease length, overriding the one the scheduler passes.
	 *
	 * The scheduler passes one TTL for every task. The lease is renewed while
	 * the task runs, so this does not need to cover the longest task: it is
	 * how long the name stays taken after an instance dies holding it.
	 */
	ttl?: Duration;
	/**
	 * Called when a running task's lease turns out to belong to someone else
	 * — it lapsed (an event loop blocked past the TTL, a store that lost the
	 * key) and another instance may now be running the same task.
	 *
	 * Without it the loss is emitted as a process warning, never dropped.
	 */
	onLeaseLost?: (name: string, error: LockNotOwnedError) => void;
}

/** A lease this instance holds, and the renewal keeping it alive. */
interface Held {
	lock: Lock;
	/** Stop renewing. Answers whether the loss was already reported. */
	stop(): boolean;
}

function reportLeaseLost(name: string, error: LockNotOwnedError): void {
	process.emitWarning(
		`Eclipse: the scheduler lease for "${name}" was lost while the task ran; another instance may have run it at the same time.`,
		{ code: error.code },
	);
}

/**
 * Renew `lock` every third of its TTL until stopped.
 *
 * The scheduler's contract carries no handle into the task, so this adapter
 * is the only layer that can keep the lease alive for as long as the task
 * runs. Each renewal asks for the TTL again and no more, so an instance that
 * dies stops renewing and the name frees within one TTL.
 */
function keepAlive(
	name: string,
	lock: Lock,
	ttl: number | null,
	onLost: (name: string, error: LockNotOwnedError) => void,
): () => boolean {
	if (ttl === null) return () => false;
	let stopped = false;
	let lost = false;
	let renewing = false;
	const timer = setInterval(
		() => {
			if (renewing) return;
			renewing = true;
			lock
				.extend(ttl)
				.catch((error: unknown) => {
					if (stopped || !(error instanceof LockNotOwnedError)) return;
					// A store failure may be transient and the lease may still be
					// ours, so the next beat tries again; a lease someone else
					// holds will not come back.
					stopped = true;
					lost = true;
					clearInterval(timer);
					onLost(name, error);
				})
				.finally(() => {
					renewing = false;
				});
		},
		Math.max(1, Math.floor(ttl / 3)),
	);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
		return lost;
	};
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
	const onLost = options.onLeaseLost ?? reportLeaseLost;
	/**
	 * The lock per held name, so `release(name)` can prove the lease is ours.
	 *
	 * The scheduler's contract releases BY NAME and carries no handle, so the
	 * owner token has to be remembered here — that token is the only thing
	 * stopping an instance whose lease already lapsed from releasing the lease
	 * a different instance has since taken.
	 */
	const held = new Map<string, Held>();
	const resolve = (): LockManager =>
		typeof manager === "function" ? manager() : manager;

	return {
		async acquire(name: string, ttlMs: number): Promise<boolean> {
			const lock = resolve()
				.use(options.store)
				.createLock(`${prefix}${name}`, resolveMs(options.ttl, ttlMs));
			// Immediately, never blocking: on each tick exactly one instance
			// should run the task and the rest should do nothing at all, not
			// queue up behind it and run it again a moment later.
			if (!(await lock.acquireImmediately())) return false;
			held.set(name, {
				lock,
				stop: keepAlive(name, lock, lock.serialize().ttl, onLost),
			});
			return true;
		},

		async release(name: string): Promise<void> {
			const entry = held.get(name);
			// Idempotent, as the scheduler's contract requires: releasing a name
			// this instance never acquired does nothing.
			if (entry === undefined) return;
			held.delete(name);
			const alreadyReported = entry.stop();
			try {
				await entry.lock.release();
			} catch (error) {
				// The scheduler calls this from a `finally`, so raising here would
				// replace whatever the task itself was reporting; the loss goes
				// to the hook instead.
				if (error instanceof LockNotOwnedError) {
					if (!alreadyReported) onLost(name, error);
					return;
				}
				throw error;
			}
		},
	};
}

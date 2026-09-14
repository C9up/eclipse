/**
 * Default `LockManager` singleton — the
 * `import locks from '@c9up/eclipse/services/main'` shape every module in the
 * cohort exposes.
 *
 * Populated by `EclipseProvider.boot()`, or by the app directly through
 * `setLocks(myManager)` when the wiring needs custom config.
 *
 *   import locks from '@c9up/eclipse/services/main'
 *
 *   const [ran] = await locks.createLock('invoices:nightly', '5m')
 *     .run(async () => generateInvoices())
 */

import type { LockManager } from "../LockManager.js";

let instance: LockManager | undefined;

/** @internal Bind the singleton (called by EclipseProvider or by the app). */
export function setLocks(value: LockManager): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getLocks(): LockManager | undefined {
	return instance;
}

/**
 * @internal Release the singleton, so a shut-down application does not leave a
 * disconnected manager reachable through `services/main`.
 */
export function clearLocks(): void {
	instance = undefined;
}

const locks: LockManager = new Proxy({} as LockManager, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it
		// reads `then` to decide whether the namespace is thenable, and various
		// symbols for interop and formatting. Throwing on those turns a plain
		// `import { setLocks } from ".../services/main"` into a crash at import
		// time, far from any real use. They are not members of what this stands
		// in for, so answer undefined and let a genuine access be the one that
		// reports.
		if (typeof prop === "symbol" || prop === "then") return undefined;
		if (!instance) {
			throw new Error(
				"[eclipse] LockManager singleton accessed before EclipseProvider.boot() ran " +
					"or `setLocks(myManager)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default locks;

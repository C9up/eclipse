/**
 * Test helpers.
 *
 * Per the cohort convention, a package's fakes live on its own `/testing`
 * subpath rather than in the runner — helix stays agnostic.
 */

import { LockManager, stores } from "../LockManager.js";
import { clearLocks, setLocks } from "../services/main.js";

/**
 * A memory-backed manager, published on `services/main` for the duration of a
 * test.
 *
 * Returns the teardown. Call it, or the next test inherits this manager
 * through the module singleton — two suites sharing a process is the normal
 * case, not the exception.
 *
 *   const restore = fakeLocks()
 *   afterEach(restore)
 */
export function fakeLocks(): () => void {
	const manager = new LockManager({
		default: "memory",
		stores: { memory: stores.memory() },
	});
	setLocks(manager);
	return () => clearLocks();
}

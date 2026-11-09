/**
 * Test helpers.
 *
 * Per the cohort convention, a package's fakes live on its own `/testing`
 * subpath rather than in the runner — helix stays agnostic.
 */

import { LockManager, stores } from "../LockManager.js";
import { clearLocks, getLocks, setLocks } from "../services/main.js";

/**
 * The container slice a fake needs — ream's `swap` / `restore`, taken
 * structurally so eclipse does not import ream.
 */
export interface FakeableContainer {
	swap(token: unknown, factory: () => unknown): void;
	restore(token: unknown): void;
}

/** Every token EclipseProvider binds the manager under. */
const TOKENS: readonly unknown[] = [LockManager, "eclipse.lock", "lock"];

/**
 * A memory-backed manager, published on `services/main` for the duration of a
 * test — and, given the application's container, behind its lock bindings
 * too, so code resolving the manager from the container gets the fake.
 *
 * Returns the teardown, which puts back what the fake replaced. Call it, or
 * the next test inherits this manager through the module singleton — two
 * suites sharing a process is the normal case, not the exception.
 *
 *   const restore = fakeLocks(app.container)
 *   afterEach(restore)
 */
export function fakeLocks(container?: FakeableContainer): () => void {
	const manager = new LockManager({
		default: "memory",
		stores: { memory: stores.memory() },
	});
	const previous = getLocks();
	setLocks(manager);
	for (const token of TOKENS) container?.swap(token, () => manager);
	return () => {
		for (const token of TOKENS) container?.restore(token);
		// Only while it is still ours: a manager bound after the fake (a
		// nested fake, an app that booted) is not this teardown's to replace.
		if (getLocks() !== manager) return;
		if (previous === undefined) clearLocks();
		else setLocks(previous);
	};
}

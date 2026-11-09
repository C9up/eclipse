import { describe, expect, it } from "vitest";
import { LockManager, stores } from "../../src/LockManager.js";
import locks, {
	clearLocks,
	getLocks,
	setLocks,
} from "../../src/services/main.js";
import { fakeLocks } from "../../src/testing/main.js";

describe("services/main", () => {
	it("answers undefined for symbols and `then`, so importing it never crashes", () => {
		clearLocks();
		// A loader reads these before anyone uses the accessor. Throwing here
		// turns a plain import into a crash far from any real use.
		expect(Reflect.get(locks, "then")).toBeUndefined();
		expect(Reflect.get(locks, Symbol.toStringTag)).toBeUndefined();
		expect(Reflect.get(locks, Symbol.iterator)).toBeUndefined();
	});

	it("reports clearly when it is used before anything bound it", () => {
		clearLocks();
		expect(() => locks.createLock("k")).toThrow(/before EclipseProvider.boot/);
	});

	it("forwards to the bound manager, with methods still bound to it", async () => {
		const manager = new LockManager({
			default: "memory",
			stores: { memory: stores.memory() },
		});
		setLocks(manager);
		try {
			const { createLock } = locks;
			expect(await createLock("k").acquireImmediately()).toBe(true);
			expect(getLocks()).toBe(manager);
		} finally {
			clearLocks();
		}
	});

	it("fakeLocks publishes a memory manager and hands back its teardown", async () => {
		clearLocks();
		const restore = fakeLocks();
		expect(await locks.createLock("k").acquireImmediately()).toBe(true);
		restore();
		expect(getLocks()).toBeUndefined();
	});

	it("fakeLocks' teardown restores the manager it replaced", () => {
		const real = new LockManager({
			default: "memory",
			stores: { memory: stores.memory() },
		});
		setLocks(real);
		const restore = fakeLocks();
		expect(getLocks()).not.toBe(real);
		restore();
		expect(getLocks()).toBe(real);
		clearLocks();
	});

	it("nested fakes unwind in order", () => {
		const real = new LockManager({
			default: "memory",
			stores: { memory: stores.memory() },
		});
		setLocks(real);
		const restoreOuter = fakeLocks();
		const outer = getLocks();
		const restoreInner = fakeLocks();
		restoreInner();
		expect(getLocks()).toBe(outer);
		restoreOuter();
		expect(getLocks()).toBe(real);
		clearLocks();
	});

	it("a stale teardown does not unpublish a manager bound after it", () => {
		clearLocks();
		const restore = fakeLocks();
		const later = new LockManager({
			default: "memory",
			stores: { memory: stores.memory() },
		});
		setLocks(later);
		restore();
		expect(getLocks()).toBe(later);
		clearLocks();
	});

	it("fakeLocks swaps the container bindings too, and restores them", async () => {
		const swapped = new Map<unknown, () => unknown>();
		const restored: unknown[] = [];
		const container = {
			swap(token: unknown, factory: () => unknown) {
				swapped.set(token, factory);
			},
			restore(token: unknown) {
				restored.push(token);
				swapped.delete(token);
			},
		};
		clearLocks();
		const restore = fakeLocks(container);
		const fake = getLocks();
		expect([...swapped.keys()]).toEqual([LockManager, "eclipse.lock", "lock"]);
		for (const factory of swapped.values()) expect(factory()).toBe(fake);
		restore();
		expect(restored).toEqual([LockManager, "eclipse.lock", "lock"]);
		expect(swapped.size).toBe(0);
	});
});

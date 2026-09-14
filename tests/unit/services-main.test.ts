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
		const restore = fakeLocks();
		expect(await locks.createLock("k").acquireImmediately()).toBe(true);
		restore();
		expect(getLocks()).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { LockManager, stores } from "../../src/LockManager.js";
import { schedulerBackend } from "../../src/scheduler.js";

const manager = (): LockManager =>
	new LockManager({ default: "memory", stores: { memory: stores.memory() } });

describe("schedulerBackend", () => {
	it("lets exactly one instance take a tick", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		expect(await a.acquire("nightly", 1_000)).toBe(true);
		expect(await b.acquire("nightly", 1_000)).toBe(false);
	});

	it("frees the name on release, so the next tick can take it", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		await a.acquire("nightly", 1_000);
		await a.release("nightly");
		expect(await b.acquire("nightly", 1_000)).toBe(true);
	});

	it("releasing a name this instance never took does nothing", async () => {
		const backend = schedulerBackend(manager());
		await expect(backend.release("never-acquired")).resolves.toBeUndefined();
	});

	it("one instance cannot release another's lease", async () => {
		const locks = manager();
		const a = schedulerBackend(locks);
		const b = schedulerBackend(locks);
		await a.acquire("nightly", 1_000);
		// b never held it, so its release is a no-op rather than a theft.
		await b.release("nightly");
		expect(await b.acquire("nightly", 1_000)).toBe(false);
	});

	it("a task that outlived its lease does not raise on the way out", async () => {
		const backend = schedulerBackend(manager());
		await backend.acquire("short", 20);
		await new Promise((resolve) => setTimeout(resolve, 40));
		// The scheduler calls release() from a finally; raising there would
		// replace whatever the task itself was reporting.
		await expect(backend.release("short")).resolves.toBeUndefined();
	});

	it("namespaces scheduler leases away from application ones", async () => {
		const locks = manager();
		const backend = schedulerBackend(locks, { prefix: "schedule:" });
		await backend.acquire("reports", 1_000);
		// An application lock on the bare name is unaffected.
		expect(await locks.createLock("reports", 1_000).acquireImmediately()).toBe(
			true,
		);
	});

	it("resolves the manager lazily — config is read before the app boots", async () => {
		let built: LockManager | undefined;
		const backend = schedulerBackend(() => {
			built ??= manager();
			return built;
		});
		expect(built).toBeUndefined();
		expect(await backend.acquire("t", 1_000)).toBe(true);
		expect(built).toBeInstanceOf(LockManager);
	});
});

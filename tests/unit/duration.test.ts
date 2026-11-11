import { describe, expect, it } from "vitest";
import { parseDuration, resolveMs } from "../../src/duration.js";
import { EclipseError, InvalidDurationError } from "../../src/errors.js";
import { LockFactory } from "../../src/LockManager.js";
import { MemoryStore } from "../../src/stores/MemoryStore.js";

/** The error `run` throws, for its class and code. */
function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a throw");
}

describe("duration", () => {
	it("is milliseconds-native, unlike echo's seconds", () => {
		expect(parseDuration("500")).toBe(500);
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("2h")).toBe(7_200_000);
	});

	it("rejects a string that is not a duration, with a coded error", () => {
		const invalid = thrown(() => parseDuration("soon"));
		expect(invalid).toBeInstanceOf(InvalidDurationError);
		expect(invalid).toBeInstanceOf(EclipseError);
		expect(invalid).toMatchObject({ code: "E_ECLIPSE_INVALID_DURATION" });
		expect(thrown(() => parseDuration("10 parsecs"))).toMatchObject({
			code: "E_ECLIPSE_INVALID_DURATION",
			message: 'Eclipse: unknown duration unit "parsecs" in "10 parsecs"',
		});
	});

	it("reads only its own units, never a member every object inherits", () => {
		for (const unit of [
			"constructor",
			"toString",
			"valueOf",
			"hasOwnProperty",
			"isPrototypeOf",
		]) {
			expect(thrown(() => parseDuration(`5${unit}`))).toMatchObject({
				code: "E_ECLIPSE_INVALID_DURATION",
				message: `Eclipse: unknown duration unit "${unit.toLowerCase()}" in "5${unit}"`,
			});
		}
	});

	it("names the unit, not a NaN, where a lock takes a duration", async () => {
		const locks = new LockFactory(new MemoryStore());
		expect(thrown(() => locks.createLock("k", "5constructor"))).toBeInstanceOf(
			InvalidDurationError,
		);
		const lock = locks.createLock("k", "1s");
		await expect(
			lock.acquire({ retry: { delay: "1toString" } }),
		).rejects.toBeInstanceOf(InvalidDurationError);
		expect(await lock.acquire()).toBe(true);
		await expect(lock.extend("2valueOf")).rejects.toBeInstanceOf(
			InvalidDurationError,
		);
		await lock.release();
	});

	it("maps null to 'never expires' and undefined to the fallback", () => {
		expect(resolveMs(null, 1_000)).toBe(null);
		expect(resolveMs(undefined, 1_000)).toBe(1_000);
		expect(resolveMs("1s", 1_000)).toBe(1_000);
	});
});

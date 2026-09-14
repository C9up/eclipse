import { describe, expect, it } from "vitest";
import { parseDuration, resolveMs } from "../../src/duration.js";

describe("duration", () => {
	it("is milliseconds-native, unlike echo's seconds", () => {
		expect(parseDuration("500")).toBe(500);
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("2h")).toBe(7_200_000);
	});

	it("rejects a string that is not a duration", () => {
		expect(() => parseDuration("soon")).toThrow(TypeError);
		expect(() => parseDuration("10 parsecs")).toThrow(/unknown duration unit/);
	});

	it("maps null to 'never expires' and undefined to the fallback", () => {
		expect(resolveMs(null, 1_000)).toBe(null);
		expect(resolveMs(undefined, 1_000)).toBe(1_000);
		expect(resolveMs("1s", 1_000)).toBe(1_000);
	});
});

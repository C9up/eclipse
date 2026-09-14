import { beforeEach, describe, expect, it, vi } from "vitest";
import { EclipseError } from "../../src/errors.js";

const loadQuasarConnection = vi.hoisted(() => vi.fn());
vi.mock("../../src/vendor/quasarConnection.js", () => ({
	quasarConnection: loadQuasarConnection,
}));

const { quasarConnection } = await import("../../src/quasar.js");

describe("quasar bridge", () => {
	// Block body, deliberately. `mockReset()` returns the mock, a mock IS a
	// function, and Vitest treats a function returned from `beforeEach` as the
	// teardown — so the concise form has Vitest CALL the mock with no arguments
	// after every test. Harmless while the implementation tolerates `undefined`,
	// and a failure the moment one does not.
	beforeEach(() => {
		loadQuasarConnection.mockReset();
	});

	it("asks the connection for eval — the release and extend are Lua scripts", async () => {
		loadQuasarConnection.mockResolvedValue({});
		await quasarConnection("main")();
		const [request] = loadQuasarConnection.mock.calls[0] ?? [];
		expect(request).toMatchObject({ pkg: "eclipse", name: "main" });
		// A connection without `eval` would acquire fine and fail on the first
		// release(), long after the config named it.
		expect(request?.required).toEqual(
			expect.arrayContaining(["set", "eval", "del", "exists"]),
		);
	});

	it("does not reach for quasar at config time, only on the first lock", () => {
		quasarConnection("main");
		expect(loadQuasarConnection).not.toHaveBeenCalled();
	});

	it("reports a missing quasar under an eclipse code, not a bare Error", async () => {
		loadQuasarConnection.mockImplementation(
			(request: { raise: (reason: string, message: string) => Error }) => {
				throw request.raise("quasar-missing", "not installed");
			},
		);
		const error = await quasarConnection()().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EclipseError);
		if (error instanceof EclipseError) {
			expect(error.code).toBe("E_ECLIPSE_QUASAR_MISSING");
		}
	});

	it("distinguishes a connection that is missing commands", async () => {
		loadQuasarConnection.mockImplementation(
			(request: { raise: (reason: string, message: string) => Error }) => {
				throw request.raise("incomplete-connection", "no eval");
			},
		);
		const error = await quasarConnection()().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EclipseError);
		if (error instanceof EclipseError) {
			expect(error.code).toBe("E_ECLIPSE_INCOMPLETE_CONNECTION");
		}
	});
});

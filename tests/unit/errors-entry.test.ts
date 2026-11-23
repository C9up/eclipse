import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors } from "../../src/index.js";

describe("the errors namespace", () => {
	it("is exported from the entry, one flare Exception per code", () => {
		const error = new errors.E_LOCK_NOT_OWNED(undefined, { key: "invoices" });
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_LOCK_NOT_OWNED);
		expect(error.code).toBe("E_LOCK_NOT_OWNED");
		expect(error.status).toBe(500);
		expect(error.key).toBe("invoices");
	});

	it("words E_LOCK_NOT_OWNED as upstream does, with no placeholder left", () => {
		expect(new errors.E_LOCK_NOT_OWNED().message).toBe(
			"Looks like you are trying to update or release a lock that is not acquired by you",
		);
	});

	it("words E_LOCK_STORAGE_ERROR as upstream does, the operation on a field", () => {
		const error = new errors.E_LOCK_STORAGE_ERROR(["ECONNRESET"], {
			operation: "save",
		});
		expect(error.code).toBe("E_LOCK_STORAGE_ERROR");
		expect(error.message).toBe("Lock storage error: ECONNRESET");
		expect(error.operation).toBe("save");
	});
});

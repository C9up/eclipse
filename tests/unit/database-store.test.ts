/**
 * Bug 016: the database lock store.
 *
 * The behaviour is exercised against a real SQLite engine (`node:sqlite`)
 * behind the structural client shape the store takes — the shape atlas' `db`
 * has — so its SQL runs for real without eclipse depending on atlas. Two
 * connections on one file stand for two replicas. PostgreSQL and MySQL are
 * covered by the statements they are sent: no server runs in this suite.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Exception } from "@c9up/flare";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	E_ECLIPSE_INVALID_CONFIG,
	E_LOCK_NOT_OWNED,
	E_LOCK_STORAGE_ERROR,
} from "../../src/errors.js";
import { defineConfig, LockManager, stores } from "../../src/LockManager.js";
import {
	DatabaseStore,
	type LockDatabase,
} from "../../src/stores/DatabaseStore.js";

const MIGRATION = `CREATE TABLE locks (
	"key" VARCHAR(255) NOT NULL PRIMARY KEY,
	"owner" VARCHAR(255) NOT NULL,
	"expiration" BIGINT
)`;

function sqlInput(value: unknown): SQLInputValue {
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "string"
	) {
		return value;
	}
	throw new Error(`unexpected binding ${String(value)}`);
}

/** A client of the store's shape over one SQLite connection. */
function sqliteClient(path = ":memory:", migrate = true) {
	const db = new DatabaseSync(path);
	if (migrate) db.exec(MIGRATION);
	const statements: string[] = [];
	const client: LockDatabase & { db: DatabaseSync; statements: string[] } = {
		db,
		statements,
		dialect: "sqlite",
		async rawQuery(sql, bindings) {
			statements.push(sql);
			return db.prepare(sql).all(...bindings.map(sqlInput));
		},
	};
	return client;
}

function rows(client: { db: DatabaseSync }) {
	return client.db
		.prepare(`SELECT "key", "owner", "expiration" FROM locks ORDER BY "key"`)
		.all();
}

/** Push a lease's expiry into the past, as time passing would. */
function lapse(client: { db: DatabaseSync }, key: string) {
	client.db
		.prepare(`UPDATE locks SET "expiration" = 1 WHERE "key" = ?`)
		.run(key);
}

describe("DatabaseStore on SQLite — the LockStore contract", () => {
	it("gives the lock to the first caller and refuses the second", async () => {
		const store = new DatabaseStore(sqliteClient());
		expect(await store.save("k", "a", 10_000)).toBe(true);
		expect(await store.save("k", "b", 10_000)).toBe(false);
		// The holder asking again is refused too, as Redis' SET NX refuses it.
		expect(await store.save("k", "a", 10_000)).toBe(false);
		expect(await store.exists("k")).toBe(true);
	});

	it("takes over a lapsed lease, without anyone cleaning up", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", 10_000);
		lapse(client, "k");
		expect(await store.exists("k")).toBe(false);
		expect(await store.save("k", "b", 10_000)).toBe(true);
		expect(rows(client)).toEqual([
			expect.objectContaining({ key: "k", owner: "b" }),
		]);
	});

	it("holds a null lease forever", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		expect(await store.save("k", "a", null)).toBe(true);
		expect(rows(client)).toEqual([{ key: "k", owner: "a", expiration: null }]);
		expect(await store.save("k", "b", 10_000)).toBe(false);
	});

	it("writes the expiry from the database clock", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		const before = Date.now();
		await store.save("k", "a", 5_000);
		const [row] = rows(client);
		const expiration = Number(row?.expiration);
		expect(expiration).toBeGreaterThanOrEqual(before + 5_000 - 5);
		expect(expiration).toBeLessThanOrEqual(Date.now() + 5_000 + 5);
	});

	it("ignores the replica's clock: one running an hour ahead does not take a live lease", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", 10_000);
		const skewed = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.now() + 3_600_000);
		try {
			expect(await store.save("k", "b", 10_000)).toBe(false);
			expect(await store.exists("k")).toBe(true);
		} finally {
			skewed.mockRestore();
		}
	});

	it("releases only for the owner", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", 10_000);
		await expect(store.delete("k", "b")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
		expect(await store.exists("k")).toBe(true);
		await store.delete("k", "a");
		expect(rows(client)).toEqual([]);
	});

	it("refuses to release a lapsed lease, as the memory store does", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", 10_000);
		lapse(client, "k");
		await expect(store.delete("k", "a")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
		await expect(store.delete("absent", "a")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
	});

	it("forceDelete takes the key back from whoever holds it", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", null);
		await store.forceDelete("k");
		expect(await store.exists("k")).toBe(false);
		expect(await store.save("k", "b", 1_000)).toBe(true);
	});

	it("extends only for the owner, from the database's now", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		await store.save("k", "a", 1_000);
		await expect(store.extend("k", "b", 60_000)).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
		await store.extend("k", "a", 60_000);
		expect(Number(rows(client)[0]?.expiration)).toBeGreaterThan(
			Date.now() + 50_000,
		);
		lapse(client, "k");
		await expect(store.extend("k", "a", 60_000)).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
	});

	it("stores an over-long key as its digest instead of failing the insert", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client);
		const key = "x".repeat(1_000);
		expect(await store.save(key, "a", 10_000)).toBe(true);
		expect(await store.save(key, "b", 10_000)).toBe(false);
		const [row] = rows(client);
		expect(String(row?.key)).toMatch(/^sha256:[0-9a-f]{64}$/);
		await store.delete(key, "a");
		expect(await store.exists(key)).toBe(false);
	});

	it("sweeps lapsed rows as it saves, so per-job keys do not grow the table forever", async () => {
		const client = sqliteClient();
		const store = new DatabaseStore(client, { sweepIntervalMs: 0 });
		for (let i = 0; i < 20; i++) await store.save(`job:${i}`, "a", 10_000);
		for (let i = 0; i < 20; i++) lapse(client, `job:${i}`);
		await store.save("fresh", "a", 10_000);
		expect(rows(client).map((row) => row.key)).toEqual(["fresh"]);
	});

	it("reports a store failure as E_LOCK_STORAGE_ERROR", async () => {
		const store = new DatabaseStore(sqliteClient(":memory:", false));
		const failure = store.save("k", "a", 1_000);
		await expect(failure).rejects.toBeInstanceOf(E_LOCK_STORAGE_ERROR);
		await expect(store.exists("k")).rejects.toMatchObject({
			code: "E_LOCK_STORAGE_ERROR",
		});
	});

	it("uses the table it is told to", async () => {
		const client = sqliteClient(":memory:", false);
		client.db.exec(MIGRATION.replace("locks", "app_locks"));
		const store = new DatabaseStore(client, { tableName: "app_locks" });
		expect(await store.save("k", "a", 1_000)).toBe(true);
		expect(client.statements.every((sql) => sql.includes('"app_locks"'))).toBe(
			true,
		);
	});
});

describe("DatabaseStore across two connections (two replicas, one file)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
	});

	it("lets exactly one replica in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eclipse-db-"));
		dirs.push(dir);
		const file = join(dir, "locks.sqlite");
		const first = sqliteClient(file);
		const second = sqliteClient(file, false);
		const a = new DatabaseStore(first);
		const b = new DatabaseStore(second);
		const results = await Promise.all([
			a.save("invoices:nightly", "replica-a", 10_000),
			b.save("invoices:nightly", "replica-b", 10_000),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		await expect(
			b.delete("invoices:nightly", "replica-b"),
		).rejects.toBeInstanceOf(E_LOCK_NOT_OWNED);
		await a.delete("invoices:nightly", "replica-a");
		expect(await b.save("invoices:nightly", "replica-b", 10_000)).toBe(true);
		first.db.close();
		second.db.close();
	});
});

/** A client that records what it is sent and answers from a script. */
function scripted(
	dialect: string,
	answer: (
		sql: string,
	) => readonly Record<string, unknown>[] | Error = () => [],
) {
	const sent: { sql: string; bindings: unknown[] }[] = [];
	const client: LockDatabase = {
		dialect,
		async rawQuery(sql, bindings) {
			sent.push({ sql, bindings });
			const reply = answer(sql);
			if (reply instanceof Error) throw reply;
			return reply;
		},
	};
	return { client, sent };
}

describe("DatabaseStore statements — PostgreSQL", () => {
	it("acquires in ONE upsert that takes over only a lapsed lease, on the server's clock", async () => {
		const { client, sent } = scripted("postgres", () => [{ key: "k" }]);
		expect(
			await new DatabaseStore(client, { sweepIntervalMs: 60_000 }).save(
				"k",
				"a",
				1_500.2,
			),
		).toBe(true);
		const insert = sent.find((s) => s.sql.startsWith("INSERT"));
		expect(insert?.sql).toContain('ON CONFLICT ("key") DO UPDATE SET');
		expect(insert?.sql).toContain("statement_timestamp()");
		expect(insert?.sql).toContain("RETURNING");
		expect(insert?.bindings).toEqual(["k", "a", 1501]);
	});

	it("answers false when the upsert returns no row", async () => {
		const { client } = scripted("pg", () => []);
		expect(await new DatabaseStore(client).save("k", "a", 1_000)).toBe(false);
	});

	it("releases and extends with the owner and the expiry in the same statement", async () => {
		const { client, sent } = scripted("postgresql", () => []);
		const store = new DatabaseStore(client);
		await expect(store.delete("k", "a")).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
		await expect(store.extend("k", "a", 10)).rejects.toBeInstanceOf(
			E_LOCK_NOT_OWNED,
		);
		expect(sent).toHaveLength(2);
		for (const { sql } of sent) {
			expect(sql).toMatch(/WHERE "key" = \? AND "owner" = \? AND/);
			expect(sql).toContain('"expiration" IS NULL OR "expiration" >');
		}
	});
});

describe("DatabaseStore statements — MySQL", () => {
	it("quotes with backticks and reads the clock with NOW(3)", async () => {
		const { client, sent } = scripted("mysql2", () => [
			{ owner: "a", live: 1 },
		]);
		await new DatabaseStore(client).exists("k");
		expect(sent[0]?.sql).toContain("`locks`");
		expect(sent[0]?.sql).toContain("NOW(3)");
	});

	it("acquires by clearing a lapsed lease, then a plain insert", async () => {
		const { client, sent } = scripted("mysql", () => []);
		expect(
			await new DatabaseStore(client, { sweepIntervalMs: 60_000 }).save(
				"k",
				"a",
				1_000,
			),
		).toBe(true);
		const statements = sent.map((s) => s.sql.split(" ")[0]);
		expect(statements).toEqual(["DELETE", "INSERT"]);
		expect(sent[0]?.sql).toContain("`expiration` IS NOT NULL");
	});

	it("reads a refused insert as 'held' when the row is there", async () => {
		const { client } = scripted("mysql", (sql) => {
			if (sql.startsWith("INSERT")) return new Error("Duplicate entry 'k'");
			if (sql.startsWith("SELECT")) return [{ found: 1 }];
			return [];
		});
		expect(await new DatabaseStore(client).save("k", "b", 1_000)).toBe(false);
	});

	it("still reports an insert that failed for another reason", async () => {
		const { client } = scripted("mysql", (sql) => {
			if (sql.startsWith("INSERT")) return new Error("connection reset");
			return [];
		});
		await expect(
			new DatabaseStore(client).save("k", "b", 1_000),
		).rejects.toBeInstanceOf(E_LOCK_STORAGE_ERROR);
	});

	it("checks the owner before a release, and deletes with the owner in the predicate", async () => {
		const owned = scripted("mysql", (sql) =>
			sql.startsWith("SELECT") ? [{ owner: "a", live: 1 }] : [],
		);
		await new DatabaseStore(owned.client).delete("k", "a");
		expect(owned.sent[1]?.sql).toMatch(
			/^DELETE FROM `locks` WHERE `key` = \? AND `owner` = \?/,
		);
		const lapsed = scripted("mysql", (sql) =>
			sql.startsWith("SELECT") ? [{ owner: "a", live: 0 }] : [],
		);
		await expect(
			new DatabaseStore(lapsed.client).delete("k", "a"),
		).rejects.toBeInstanceOf(E_LOCK_NOT_OWNED);
		expect(lapsed.sent).toHaveLength(1);
	});

	it("extends, then reads the lease back to know whether it was ours", async () => {
		const other = scripted("mysql", (sql) =>
			sql.startsWith("SELECT") ? [{ owner: "b", live: 1 }] : [],
		);
		await expect(
			new DatabaseStore(other.client).extend("k", "a", 1_000),
		).rejects.toBeInstanceOf(E_LOCK_NOT_OWNED);
		expect(other.sent.map((s) => s.sql.split(" ")[0])).toEqual([
			"UPDATE",
			"SELECT",
		]);
	});
});

describe("DatabaseStore configuration", () => {
	it("refuses a dialect it has no SQL for", async () => {
		const { client } = scripted("mssql");
		const failure = new DatabaseStore(client).exists("k");
		await expect(failure).rejects.toBeInstanceOf(Exception);
		await expect(new DatabaseStore(client).exists("k")).rejects.toMatchObject({
			code: "E_ECLIPSE_UNSUPPORTED_DATABASE",
		});
	});

	it("refuses a table name that is not an identifier, where it is configured", () => {
		expect(() =>
			stores.database({ tableName: 'locks"; DROP TABLE users; --' }),
		).toThrow(E_ECLIPSE_INVALID_CONFIG);
	});

	it("is reachable from the config as stores.database()", async () => {
		const client = sqliteClient();
		const locks = new LockManager(
			defineConfig({
				default: "database",
				stores: { database: stores.database({ connection: client }) },
			}),
		);
		const [ran, value] = await locks.createLock("k", "1s").run(async () => 42);
		expect(ran).toBe(true);
		expect(value).toBe(42);
		expect(rows(client)).toEqual([]);
		// It never owns the connection it was handed.
		await locks.disconnectAll();
		expect(client.db.isOpen).toBe(true);
	});
});

describe("stores.database() loads atlas lazily", () => {
	const SPECIFIER = "@c9up/atlas/services/db";

	afterEach(() => {
		vi.doUnmock(SPECIFIER);
		vi.resetModules();
	});

	it("does not load atlas until the first lock", async () => {
		const factory = vi.fn();
		vi.doMock(SPECIFIER, () => {
			factory();
			return { default: sqliteClient() };
		});
		const { stores: fresh } = await import("../../src/LockManager.js");
		const store = fresh.database()();
		expect(factory).not.toHaveBeenCalled();
		expect(await store.save("k", "a", 1_000)).toBe(true);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("scopes atlas' db to the named connection", async () => {
		const named = sqliteClient();
		const connection = vi.fn(() => named);
		vi.doMock(SPECIFIER, () => ({
			default: { dialect: "sqlite", rawQuery: vi.fn(), connection },
		}));
		const { stores: fresh } = await import("../../src/LockManager.js");
		await fresh.database({ connection: "locks" })().save("k", "a", 1_000);
		expect(connection).toHaveBeenCalledWith("locks");
		expect(named.statements.length).toBeGreaterThan(0);
	});

	it("says atlas is missing, and offers the alternative", async () => {
		vi.doMock(SPECIFIER, () => {
			throw new Error("Cannot find module");
		});
		const { stores: fresh } = await import("../../src/LockManager.js");
		await expect(fresh.database()().exists("k")).rejects.toMatchObject({
			code: "E_ECLIPSE_DATABASE_UNAVAILABLE",
			message: expect.stringMatching(/not installed.*connection: db/),
		});
	});

	it("says so when atlas has not booted, and asks again on the next lock", async () => {
		let booted = false;
		const client = sqliteClient();
		vi.doMock(SPECIFIER, () => ({
			default: {
				get dialect(): string {
					if (!booted) {
						throw new Error(
							"db singleton accessed before AtlasProvider.boot()",
						);
					}
					return client.dialect;
				},
				rawQuery: client.rawQuery,
			},
		}));
		const { stores: fresh } = await import("../../src/LockManager.js");
		const store = fresh.database()();
		await expect(store.exists("k")).rejects.toThrow(/provider has not booted/);
		booted = true;
		expect(await store.save("k", "a", 1_000)).toBe(true);
	});
});

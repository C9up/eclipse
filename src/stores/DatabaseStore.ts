/**
 * Database lock store — a distributed lock for an application that has a SQL
 * database (PostgreSQL, MySQL, SQLite) and no Redis.
 *
 * No import of a data layer. The client is taken structurally — a `dialect`
 * and a `rawQuery(sql, bindings)` — which is the shape atlas' `db` service
 * has, so `stores.database()` locks through atlas without eclipse depending on
 * it: atlas is loaded on the first lock, only by an application that locks
 * this way.
 *
 * The table has three columns: `key` (primary), `owner`, `expiration` (epoch
 * milliseconds, `NULL` for a lease that never expires); the migration ships as
 * `stubs/database/migrations/9200_create_locks.stub`.
 *
 * Better than upstream, deliberately:
 * - expiry is read and written on the DATABASE clock, not the replica's. A
 *   replica whose clock runs ahead would otherwise see a live lease as lapsed
 *   and take it while its holder is still working — the double run the lock
 *   exists to prevent;
 * - acquiring is ONE atomic statement on PostgreSQL and SQLite (an upsert that
 *   takes over only a lapsed row), not an insert followed by an update;
 * - releasing a lapsed lease raises `E_LOCK_NOT_OWNED`, as the memory and
 *   Redis stores do;
 * - lapsed rows are deleted as locks are taken (at most once a minute), so a
 *   workload that locks per job id does not grow the table forever, and a key
 *   longer than the column is stored as its SHA-256 instead of failing.
 */

import { createHash } from "node:crypto";
import {
	E_ECLIPSE_DATABASE_UNAVAILABLE,
	E_ECLIPSE_INVALID_CONFIG,
	E_ECLIPSE_UNSUPPORTED_DATABASE,
	E_LOCK_NOT_OWNED,
	E_LOCK_STORAGE_ERROR,
} from "../errors.js";
import { isEclipseError, reasonOf } from "../isEclipseError.js";
import type { LockStore } from "../types.js";

/** A row as the database hands it back. */
export type LockRow = Record<string, unknown>;

/**
 * The slice of a database client this store issues. atlas' `db` service
 * (`import db from '@c9up/atlas/services/db'`) has this shape, and so can
 * anything else.
 *
 * Raw SQL rather than a query builder, deliberately: an acquire is ONE upsert
 * that takes over only a lapsed lease and reads the database clock, a dialect
 * statement no portable builder call expresses. `?` placeholders, bound
 * positionally.
 */
export interface LockDatabase {
	/** `postgres`, `mysql` or `sqlite` (atlas' names; `pg`, `mysql2`, `sqlite3` and `better-sqlite3` too). */
	readonly dialect: string;
	rawQuery(sql: string, bindings: unknown[]): PromiseLike<readonly LockRow[]>;
}

/**
 * How the store gets its client: the client itself, or something that answers
 * with one — what a config file needs, since it is read before the database
 * connection exists.
 */
export type LockDatabaseSource =
	| LockDatabase
	| (() => LockDatabase | Promise<LockDatabase>);

export interface DatabaseStoreOptions {
	/** The table. Default `"locks"`; may be schema-qualified (`"app.locks"`). */
	tableName?: string;
	/**
	 * How often, at most, a save deletes the lapsed rows. Default one minute.
	 * `0` sweeps on every save.
	 */
	sweepIntervalMs?: number;
}

type SqlDialect = "postgres" | "mysql" | "sqlite";

const DIALECTS = new Map<string, SqlDialect>([
	["postgres", "postgres"],
	["postgresql", "postgres"],
	["pg", "postgres"],
	["mysql", "mysql"],
	["mysql2", "mysql"],
	["sqlite", "sqlite"],
	["sqlite3", "sqlite"],
	["better-sqlite3", "sqlite"],
]);

/**
 * The database's own "now", in epoch milliseconds, read once per statement.
 *
 * `statement_timestamp()` rather than `now()`: inside a transaction `now()` is
 * frozen at its start, and a lease compared against it would never lapse.
 */
const NOW: Record<SqlDialect, string> = {
	postgres: "CAST(EXTRACT(EPOCH FROM statement_timestamp()) * 1000 AS BIGINT)",
	mysql: "CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)",
	sqlite: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
};

/** The integer type a bound duration is cast to before it is added to now. */
const INTEGER: Record<SqlDialect, string> = {
	postgres: "BIGINT",
	mysql: "SIGNED",
	sqlite: "INTEGER",
};

/** A table name: an identifier, optionally schema-qualified. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** The longest key stored as written; a longer one is stored as its digest. */
const MAX_KEY_LENGTH = 255;

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Refuse a table name that is not one, where it is configured.
 *
 * It is spliced into every statement, so it is the one value here that cannot
 * be bound.
 */
export function assertTableName(table: string | undefined): void {
	if (table !== undefined && !TABLE_NAME.test(table)) {
		throw new E_ECLIPSE_INVALID_CONFIG([
			`the database lock store's tableName ${JSON.stringify(table)} is not a table name`,
		]);
	}
}

function isLockDatabase(value: unknown): value is LockDatabase {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "rawQuery") === "function" &&
		typeof Reflect.get(value, "dialect") === "string"
	);
}

/** A whole number out of a column, however the driver typed it. */
function toInteger(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint" || typeof value === "string") {
		return Number(value);
	}
	return Number.NaN;
}

/**
 * atlas' `db`, scoped to the named connection or left on the default one,
 * loaded only when a database store first locks. The specifier is built at
 * run time: atlas is not a dependency of this package, and an application on
 * another data layer never loads it.
 */
export async function atlasDatabase(
	name: string | undefined,
): Promise<LockDatabase> {
	const specifier = "@c9up/atlas/services/db";
	const which =
		name === undefined ? "default connection" : `connection "${name}"`;
	let loaded: unknown;
	try {
		loaded = await import(/* @vite-ignore */ specifier);
	} catch (cause) {
		throw new E_ECLIPSE_DATABASE_UNAVAILABLE(
			[
				`the database lock store asks for atlas' ${which}, but @c9up/atlas is not installed. Install it, or pass a client: stores.database({ connection: db })`,
			],
			{ cause },
		);
	}
	let scoped: unknown;
	try {
		const db: unknown = Reflect.get(Object(loaded), "default");
		const connection: unknown = Reflect.get(Object(db), "connection");
		scoped =
			name === undefined || typeof connection !== "function"
				? db
				: Reflect.apply(connection, db, [name]);
		// Reading `dialect` is what tells a booted atlas from one that is not.
		if (isLockDatabase(scoped)) return scoped;
	} catch (cause) {
		throw new E_ECLIPSE_DATABASE_UNAVAILABLE(
			[
				`atlas' ${which} is not available to the database lock store: its provider has not booted, or the connection is not configured`,
			],
			{ cause },
		);
	}
	throw new E_ECLIPSE_DATABASE_UNAVAILABLE([
		`@c9up/atlas/services/db did not expose a client with \`dialect\` and \`rawQuery()\` for the ${which}`,
	]);
}

interface Resolved {
	db: LockDatabase;
	dialect: SqlDialect;
}

/** The statement fragments of one dialect, built once. */
interface Names {
	table: string;
	key: string;
	owner: string;
	expiration: string;
	now: string;
	/** `expiration` is unset, or still ahead of the database clock. */
	live: string;
}

export class DatabaseStore implements LockStore {
	readonly #source: LockDatabaseSource;
	readonly #table: string;
	readonly #sweepIntervalMs: number;
	#resolved: Promise<Resolved> | undefined;
	#lastSweep = Date.now();

	constructor(source: LockDatabaseSource, options: DatabaseStoreOptions = {}) {
		assertTableName(options.tableName);
		this.#source = source;
		this.#table = options.tableName ?? "locks";
		this.#sweepIntervalMs =
			options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
	}

	/**
	 * The client and its dialect, resolved once and kept — once it SUCCEEDED.
	 *
	 * A failed resolution is forgotten, so the next lock asks again: a lock
	 * taken before atlas has booted must not disable every lock until the
	 * process restarts.
	 */
	#db(): Promise<Resolved> {
		if (this.#resolved === undefined) {
			const source = this.#source;
			const pending = Promise.resolve()
				.then(() => (typeof source === "function" ? source() : source))
				.then((db): Resolved => {
					const dialect = DIALECTS.get(db.dialect.toLowerCase());
					if (dialect === undefined) {
						throw new E_ECLIPSE_UNSUPPORTED_DATABASE([db.dialect]);
					}
					return { db, dialect };
				});
			this.#resolved = pending;
			pending.catch(() => {
				if (this.#resolved === pending) this.#resolved = undefined;
			});
		}
		return this.#resolved;
	}

	/** Identifiers quoted for the dialect (`key` is reserved on MySQL). */
	#names(dialect: SqlDialect): Names {
		const quote = (name: string) =>
			dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
		const expiration = quote("expiration");
		const now = NOW[dialect];
		return {
			table: this.#table.split(".").map(quote).join("."),
			key: quote("key"),
			owner: quote("owner"),
			expiration,
			now,
			live: `(${expiration} IS NULL OR ${expiration} > ${now})`,
		};
	}

	#key(key: string): string {
		return key.length <= MAX_KEY_LENGTH
			? key
			: `sha256:${createHash("sha256").update(key).digest("hex")}`;
	}

	/**
	 * Every statement goes through here so a store failure is reported as one
	 * (`E_LOCK_STORAGE_ERROR`); an eclipse error keeps its own code.
	 */
	async #issue<T>(
		operation: string,
		run: (db: LockDatabase, dialect: SqlDialect, n: Names) => Promise<T>,
	): Promise<T> {
		try {
			const { db, dialect } = await this.#db();
			return await run(db, dialect, this.#names(dialect));
		} catch (cause) {
			if (isEclipseError(cause)) throw cause;
			throw new E_LOCK_STORAGE_ERROR([reasonOf(cause)], {
				cause: cause,
				operation,
			});
		}
	}

	/** Delete the lapsed rows, at most once per sweep interval. */
	async #sweep(db: LockDatabase, n: Names): Promise<void> {
		const now = Date.now();
		if (now - this.#lastSweep < this.#sweepIntervalMs) return;
		this.#lastSweep = now;
		await db.rawQuery(
			`DELETE FROM ${n.table} WHERE ${n.expiration} IS NOT NULL AND ${n.expiration} <= ${n.now}`,
			[],
		);
	}

	/**
	 * Take the key, or a lapsed lease on it.
	 *
	 * PostgreSQL and SQLite: one upsert whose update only fires on a lapsed
	 * row, and `RETURNING` says whether a row was written — atomic on the
	 * server, whoever asks at the same instant. MySQL has no `RETURNING` and
	 * `rawQuery` answers rows, not a count: a lapsed lease is deleted first,
	 * then a plain insert either lands or hits the primary key. The owner
	 * predicate is never relied on to tell them apart, so a holder asking
	 * again is refused on every dialect, as Redis' `SET NX` refuses it.
	 */
	save(key: string, owner: string, ttl: number | null): Promise<boolean> {
		return this.#issue("save", async (db, dialect, n) => {
			await this.#sweep(db, n);
			const id = this.#key(key);
			const expiry =
				ttl === null ? "NULL" : `${n.now} + CAST(? AS ${INTEGER[dialect]})`;
			// A TTL is an integer number of milliseconds on every store.
			const bindings = ttl === null ? [id, owner] : [id, owner, Math.ceil(ttl)];
			const insert = `INSERT INTO ${n.table}`;
			const columns = `(${n.key}, ${n.owner}, ${n.expiration}) VALUES (?, ?, ${expiry})`;
			if (dialect !== "mysql") {
				const rows = await db.rawQuery(
					`${insert} AS cur ${columns} ` +
						`ON CONFLICT (${n.key}) DO UPDATE SET ${n.owner} = excluded.${n.owner}, ${n.expiration} = excluded.${n.expiration} ` +
						`WHERE cur.${n.expiration} IS NOT NULL AND cur.${n.expiration} <= ${n.now} ` +
						`RETURNING ${n.key}`,
					bindings,
				);
				return rows.length > 0;
			}
			await db.rawQuery(
				`DELETE FROM ${n.table} WHERE ${n.key} = ? AND ${n.expiration} IS NOT NULL AND ${n.expiration} <= ${n.now}`,
				[id],
			);
			try {
				await db.rawQuery(`${insert} ${columns}`, bindings);
				return true;
			} catch (cause) {
				// The insert was refused. If the key is held, that was the primary
				// key — someone else has the lock; otherwise it is a real failure.
				const held = await db.rawQuery(
					`SELECT 1 AS found FROM ${n.table} WHERE ${n.key} = ?`,
					[id],
				);
				if (held.length > 0) return false;
				throw cause;
			}
		});
	}

	delete(key: string, owner: string): Promise<void> {
		return this.#issue("delete", async (db, dialect, n) => {
			const id = this.#key(key);
			if (dialect !== "mysql") {
				const rows = await db.rawQuery(
					`DELETE FROM ${n.table} WHERE ${n.key} = ? AND ${n.owner} = ? AND ${n.live} RETURNING ${n.key}`,
					[id, owner],
				);
				if (rows.length === 0) throw new E_LOCK_NOT_OWNED(undefined, { key });
				return;
			}
			// Checked, then deleted with the owner in the predicate: if the lease
			// lapses and is taken in between, the delete matches nothing, and the
			// new holder's lease is left alone.
			if (!(await this.#heldBy(db, n, id, owner))) {
				throw new E_LOCK_NOT_OWNED(undefined, { key });
			}
			await db.rawQuery(
				`DELETE FROM ${n.table} WHERE ${n.key} = ? AND ${n.owner} = ?`,
				[id, owner],
			);
		});
	}

	forceDelete(key: string): Promise<void> {
		return this.#issue("forceDelete", async (db, _dialect, n) => {
			await db.rawQuery(`DELETE FROM ${n.table} WHERE ${n.key} = ?`, [
				this.#key(key),
			]);
		});
	}

	exists(key: string): Promise<boolean> {
		return this.#issue("exists", async (db, _dialect, n) => {
			const rows = await db.rawQuery(
				`SELECT 1 AS found FROM ${n.table} WHERE ${n.key} = ? AND ${n.live}`,
				[this.#key(key)],
			);
			return rows.length > 0;
		});
	}

	extend(key: string, owner: string, duration: number): Promise<void> {
		return this.#issue("extend", async (db, dialect, n) => {
			const id = this.#key(key);
			const update =
				`UPDATE ${n.table} SET ${n.expiration} = ${n.now} + CAST(? AS ${INTEGER[dialect]}) ` +
				`WHERE ${n.key} = ? AND ${n.owner} = ? AND ${n.live}`;
			const bindings = [Math.ceil(duration), id, owner];
			if (dialect !== "mysql") {
				const rows = await db.rawQuery(
					`${update} RETURNING ${n.key}`,
					bindings,
				);
				if (rows.length === 0) throw new E_LOCK_NOT_OWNED(undefined, { key });
				return;
			}
			await db.rawQuery(update, bindings);
			// Read back: once extended, nobody else can take the key before the
			// new expiry, so "ours and live" now means the update landed.
			if (!(await this.#heldBy(db, n, id, owner))) {
				throw new E_LOCK_NOT_OWNED(undefined, { key });
			}
		});
	}

	/** Whether `owner` holds a live lease on `id` (the MySQL read-back). */
	async #heldBy(
		db: LockDatabase,
		n: Names,
		id: string,
		owner: string,
	): Promise<boolean> {
		const rows = await db.rawQuery(
			`SELECT ${n.owner} AS owner, CASE WHEN ${n.live} THEN 1 ELSE 0 END AS live FROM ${n.table} WHERE ${n.key} = ?`,
			[id],
		);
		const row = rows[0];
		return (
			row !== undefined && row.owner === owner && toInteger(row.live) === 1
		);
	}
}

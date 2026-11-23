/**
 * Eclipse errors, one per code.
 *
 * Two of the codes are upstream's, verbatim. `E_LOCK_NOT_OWNED` and
 * `E_LOCK_STORAGE_ERROR` are what verrou raises and what any code written
 * against a lock module already catches on, so renaming them to the
 * `E_ECLIPSE_*` shape would break the catch for no gain — the same reasoning
 * that keeps `E_UNAUTHORIZED_ACCESS` and `E_VALIDATION_ERROR` unprefixed
 * elsewhere. Codes eclipse invents carry the namespace.
 */
import { createError, Exception, format } from "@c9up/flare";

/**
 * A lock was released, extended or inspected by something that is not its
 * owner.
 *
 * This is the failure that makes a distributed lock worth having. A plain
 * "delete the key" release lets an instance whose lease already expired remove
 * the lease a DIFFERENT instance has since taken — freeing the name while work
 * is still running under it. Owner-checked operations turn that into this
 * error instead of silent corruption.
 *
 * The message is upstream's, verbatim and without a placeholder; the lock's
 * name is on `key` when the store knows it.
 */
export class E_LOCK_NOT_OWNED extends Exception {
	static override message =
		"Looks like you are trying to update or release a lock that is not acquired by you";
	static override code = "E_LOCK_NOT_OWNED";

	/** The name of the lock the caller no longer owns. */
	readonly key: string | undefined;

	constructor(args?: unknown[], options?: ErrorOptions & { key?: string }) {
		super(format(E_LOCK_NOT_OWNED.message, args ?? []), options);
		this.name = "Exception";
		this.key = options?.key;
	}
}

/**
 * The underlying store failed while saving, reading or deleting.
 *
 * The message is upstream's, `Lock storage error: %s` with the store's reason;
 * the operation that failed is on `operation`.
 */
export class E_LOCK_STORAGE_ERROR extends Exception {
	static override message = "Lock storage error: %s";
	static override code = "E_LOCK_STORAGE_ERROR";

	/** The store operation that failed: `save`, `delete`, `extend`, ... */
	readonly operation: string | undefined;

	constructor(args: [string], options?: ErrorOptions & { operation?: string }) {
		super(format(E_LOCK_STORAGE_ERROR.message, args), options);
		this.name = "Exception";
		this.operation = options?.operation;
	}
}

/**
 * A TTL that cannot bound anything.
 *
 * A zero or negative lease expires the instant it is taken, so every instance
 * acquires the same lock and runs the same work — the exact outcome locking
 * exists to prevent, arriving silently.
 */
export const E_ECLIPSE_INVALID_TTL = createError<[string]>(
	"Eclipse: lock TTL must be a finite positive number of milliseconds, or null for no expiry — got %s",
	"E_ECLIPSE_INVALID_TTL",
);

/**
 * A retry option that cannot bound the wait.
 *
 * `Number(env.LOCK_TIMEOUT)` on an unset variable is `NaN`, and a `NaN`
 * deadline is never reached while a `NaN` or negative delay sleeps 1ms: every
 * replica then polls the shared store in a tight loop, forever.
 */
export const E_ECLIPSE_INVALID_RETRY = createError<[string, string, string]>(
	"Eclipse: retry.%s must be %s — got %s",
	"E_ECLIPSE_INVALID_RETRY",
);

/**
 * A duration string that is not a number with a known unit.
 *
 * Upstream throws an uncoded error for the same input; this one carries the
 * namespace, so a caller tells a mistyped `"5mins"` from a store failure.
 */
export const E_ECLIPSE_INVALID_DURATION = createError<[string]>(
	"Eclipse: %s",
	"E_ECLIPSE_INVALID_DURATION",
);

/**
 * The provider is registered but `config/lock.ts` is missing.
 *
 * Falling back to an in-process store would let every replica take every
 * lock, and nothing would say so.
 */
export const E_ECLIPSE_MISSING_CONFIG = createError(
	"Eclipse: config/lock.ts is missing. Run `ream configure @c9up/eclipse`, or export defineConfig({ default, stores }) from it.",
	"E_ECLIPSE_MISSING_CONFIG",
);

/** A lock config that is not `{ default, stores }`, or a store option that cannot work. */
export const E_ECLIPSE_INVALID_CONFIG = createError<[string]>(
	"Eclipse: %s",
	"E_ECLIPSE_INVALID_CONFIG",
);

/** A config names a store that does not exist. */
export const E_ECLIPSE_UNKNOWN_STORE = createError<[string, string]>(
	'Eclipse: unknown lock store "%s". Declared stores: %s',
	"E_ECLIPSE_UNKNOWN_STORE",
);

/** The container resolved the `LockManager` token to something that is not a `LockManager`. */
export const E_ECLIPSE_INVALID_BINDING = createError(
	"[eclipse] the container returned something that is not a LockManager for the LockManager token.",
	"E_ECLIPSE_INVALID_BINDING",
);

/** The lock manager singleton was used before it was wired. */
export const E_ECLIPSE_NOT_BOOTED = createError(
	"[eclipse] LockManager singleton accessed before EclipseProvider.boot() ran or `setLocks(myManager)` was called. Wire one of them first.",
	"E_ECLIPSE_NOT_BOOTED",
);

/** A Redis store needs `@c9up/quasar`, and it is not installed. */
export const E_ECLIPSE_QUASAR_MISSING = createError<[string]>(
	"%s",
	"E_ECLIPSE_QUASAR_MISSING",
);

/** The quasar connection lacks a command the Redis store needs. */
export const E_ECLIPSE_INCOMPLETE_CONNECTION = createError<[string]>(
	"%s",
	"E_ECLIPSE_INCOMPLETE_CONNECTION",
);

/** The database store asked atlas for a client it could not get. */
export const E_ECLIPSE_DATABASE_UNAVAILABLE = createError<[string]>(
	"Eclipse: %s",
	"E_ECLIPSE_DATABASE_UNAVAILABLE",
);

/** The database store was given a client of a dialect it does not support. */
export const E_ECLIPSE_UNSUPPORTED_DATABASE = createError<[string]>(
	'Eclipse: the database lock store supports PostgreSQL, MySQL and SQLite — got the "%s" dialect',
	"E_ECLIPSE_UNSUPPORTED_DATABASE",
);

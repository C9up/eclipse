/**
 * Eclipse errors.
 *
 * Two of the codes are upstream's, verbatim. `E_LOCK_NOT_OWNED` and
 * `E_LOCK_STORAGE_ERROR` are what verrou raises and what any code written
 * against a lock module already catches on, so renaming them to the
 * `E_ECLIPSE_*` shape would break the catch for no gain — the same reasoning
 * that keeps `E_UNAUTHORIZED_ACCESS` and `E_VALIDATION_ERROR` unprefixed
 * elsewhere. Codes eclipse invents carry the namespace.
 */

/** Base class, so a caller can catch every eclipse error by one name. */
export class EclipseError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/**
 * Raised when a lock is released, extended or inspected by something that is
 * not its owner.
 *
 * This is the failure that makes a distributed lock worth having. A plain
 * "delete the key" release lets an instance whose lease already expired remove
 * the lease a DIFFERENT instance has since taken — freeing the name while work
 * is still running under it. Owner-checked operations turn that into this
 * error instead of silent corruption.
 */
export class LockNotOwnedError extends EclipseError {
	constructor(key: string) {
		super(
			"E_LOCK_NOT_OWNED",
			`Eclipse: lock "${key}" is not owned by this holder — it expired, or another holder has it`,
		);
	}
}

/** Raised when the underlying store fails while saving, reading or deleting. */
export class LockStorageError extends EclipseError {
	constructor(operation: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			"E_LOCK_STORAGE_ERROR",
			`Eclipse: the lock store failed during ${operation}: ${reason}`,
			{ cause },
		);
	}
}

/**
 * Raised for a TTL that cannot bound anything.
 *
 * A zero or negative lease expires the instant it is taken, so every instance
 * acquires the same lock and runs the same work — the exact outcome locking
 * exists to prevent, arriving silently.
 */
export class InvalidTtlError extends EclipseError {
	constructor(ttl: unknown) {
		super(
			"E_ECLIPSE_INVALID_TTL",
			`Eclipse: lock TTL must be a finite positive number of milliseconds, or null for no expiry — got ${String(ttl)}`,
		);
	}
}

/** Raised when a config names a store that does not exist. */
export class UnknownStoreError extends EclipseError {
	constructor(name: string, known: readonly string[]) {
		super(
			"E_ECLIPSE_UNKNOWN_STORE",
			`Eclipse: unknown lock store "${name}". Declared stores: ${known.join(", ") || "(none)"}`,
		);
	}
}

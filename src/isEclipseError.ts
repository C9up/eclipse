/**
 * Tells eclipse's own errors from anything else a store call throws, so a
 * store wraps a driver failure in `E_LOCK_STORAGE_ERROR` while a lost lease
 * or a missing quasar keeps its own code.
 */
import type { Exception } from "@c9up/flare";
import * as errors from "./errors.js";

const classes = Object.values(errors);

/** Whether `value` is one of the errors this package declares. */
export function isEclipseError(value: unknown): value is Exception {
	return classes.some((ErrorClass) => value instanceof ErrorClass);
}

/** The text of a failure that may not be an `Error`. */
export function reasonOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Eclipse does not depend on quasar: it is an optional peer, and neither this
 * module nor the vendored loader it calls imports it statically. The loading,
 * the shape check and the messages are the same in every package that offers
 * a Redis-backed option, so they are vendored rather than written again —
 * `src/vendor/quasarConnection.ts`, generated from one source.
 */

import { EclipseError } from "./errors.js";
import type { LockRedisClient } from "./stores/RedisStore.js";
import {
	hasCommands,
	quasarConnection as loadQuasarConnection,
} from "./vendor/quasarConnection.js";

/**
 * The commands this store actually issues.
 *
 * `eval` is in the list because the owner-checked release and extend are Lua
 * scripts — a connection without it would fail on the first `release()`,
 * long after the config named it.
 */
const REQUIRED = ["set", "eval", "del", "exists"] as const;

/**
 * The connection is handed over only once it carries every command above.
 */
function isLockRedisClient(value: unknown): value is LockRedisClient {
	return hasCommands(value, REQUIRED);
}

/**
 * A resolver for `stores.redis({ connection })` — quasar is loaded on the
 * first lock, not at config time.
 */
export function quasarConnection(
	name?: string,
): () => Promise<LockRedisClient> {
	return async () =>
		loadQuasarConnection({
			pkg: "eclipse",
			name,
			required: REQUIRED,
			isConnection: isLockRedisClient,
			what: "the lock store",
			alternative: "or pass a client directly: stores.redis({ client })",
			raise: (reason, message, cause) =>
				new EclipseError(
					reason === "quasar-missing"
						? "E_ECLIPSE_QUASAR_MISSING"
						: "E_ECLIPSE_INCOMPLETE_CONNECTION",
					message,
					{ cause },
				),
		});
}

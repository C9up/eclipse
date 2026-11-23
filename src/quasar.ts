/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Eclipse does not depend on quasar: it is an optional peer, and neither this
 * module nor the vendored loader it calls imports it statically. The loading,
 * the shape check and the messages are the same in every package that offers
 * a Redis-backed option, so they are vendored rather than written again —
 * `src/vendor/quasarConnection.ts`, generated from one source.
 */

import {
	E_ECLIPSE_INCOMPLETE_CONNECTION,
	E_ECLIPSE_QUASAR_MISSING,
} from "./errors.js";
import type { LockRedisClient } from "./stores/RedisStore.js";
import {
	hasCommands,
	quasarConnection as loadQuasarConnection,
} from "./vendor/quasarConnection.js";

/**
 * The commands this store actually issues.
 *
 * `evalsha` and `script` are in the list because the owner-checked release and
 * extend are Lua scripts, run by SHA1 and loaded with SCRIPT LOAD when Redis
 * does not know them — a connection without them would fail on the first
 * `release()`, long after the config named it.
 */
const REQUIRED = ["set", "evalsha", "script", "del", "exists"] as const;

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
				reason === "quasar-missing"
					? new E_ECLIPSE_QUASAR_MISSING([message], { cause })
					: new E_ECLIPSE_INCOMPLETE_CONNECTION([message], { cause }),
		});
}

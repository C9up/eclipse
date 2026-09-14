/**
 * Eclipse — distributed locks for the Ream framework.
 *
 * One name, one holder. Everything else is a store detail.
 *
 *   import { LockManager, defineConfig, stores } from "@c9up/eclipse"
 *
 *   const locks = new LockManager(defineConfig({
 *     default: "redis",
 *     stores: { redis: stores.redis({ connection: "main" }) },
 *   }))
 *
 *   // run once across every replica, wait for whoever is running it
 *   const [ran, invoices] = await locks
 *     .createLock("invoices:nightly", "5m")
 *     .run(async () => generateInvoices())
 */

// Contributes this package's tokens to ream's ContainerBindings. Type-only.
import "./augmentations.js";

export { type Duration, parseDuration, resolveMs } from "./duration.js";
export {
	EclipseError,
	InvalidTtlError,
	LockNotOwnedError,
	LockStorageError,
	UnknownStoreError,
} from "./errors.js";
export { assertValidTtl, Lock } from "./Lock.js";
export {
	defineConfig,
	type LockConfig,
	LockFactory,
	LockManager,
	type StoreFactory,
	stores,
} from "./LockManager.js";
export { MemoryStore } from "./stores/MemoryStore.js";
export {
	type LockRedisClient,
	type LockRedisResolver,
	RedisStore,
	type RedisStoreOptions,
} from "./stores/RedisStore.js";
export type {
	LockAcquireOptions,
	LockFactoryOptions,
	LockStore,
	ResolvedLockConfig,
	RetryConfig,
	SerializedLock,
} from "./types.js";

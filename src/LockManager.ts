/**
 * Multi-store lock manager — `{ default, stores }` config plus
 * `lock.use(name)`, the shape every other pluggable module in the cohort
 * takes (echo's `CacheStoreManager`, bay's queue manager).
 *
 *   const locks = new LockManager(defineConfig({
 *     default: "redis",
 *     stores: {
 *       memory: stores.memory(),
 *       redis: stores.redis({ connection: "main" }),
 *     },
 *   }))
 *
 *   const [ran, result] = await locks.createLock("invoices:nightly", "5m")
 *     .run(async () => generateInvoices())
 */

import { type Duration, resolveMs } from "./duration.js";
import { InvalidConfigError, UnknownStoreError } from "./errors.js";
import { assertValidTtl, Lock, resolveRetry } from "./Lock.js";
import { quasarConnection } from "./quasar.js";
import { MemoryStore } from "./stores/MemoryStore.js";
import {
	type LockRedisClient,
	RedisStore,
	type RedisStoreOptions,
} from "./stores/RedisStore.js";
import type {
	LockFactoryOptions,
	LockStore,
	ResolvedLockConfig,
	SerializedLock,
} from "./types.js";

/** A lazily-instantiated store (built once per name, on first use). */
export type StoreFactory = () => LockStore;

export interface LockConfig extends LockFactoryOptions {
	default: string;
	stores: Record<string, StoreFactory>;
}

/** Defaults applied when a config, a factory or a call does not say. */
const DEFAULTS = {
	/** Long enough for ordinary work, short enough that a crash recovers fast. */
	ttl: 30_000,
	delay: 250,
	attempts: Number.POSITIVE_INFINITY,
} as const;

/** Validated here, so a bad default fails where it is configured, not on first use. */
function resolveConfig(options: LockFactoryOptions = {}): ResolvedLockConfig {
	const ttl = resolveMs(options.ttl, DEFAULTS.ttl);
	assertValidTtl(ttl);
	return {
		retry: resolveRetry(options.retry, {
			attempts: DEFAULTS.attempts,
			delay: DEFAULTS.delay,
			timeout: undefined,
		}),
		ttl,
	};
}

/**
 * Check a config where it is written rather than where it is consumed — the
 * `defineConfig` every ream module exposes.
 *
 * `default: env.get('LOCK_STORE')` is `undefined` when the variable is unset,
 * so the shape is checked at run time too, not only by the compiler.
 */
export function defineConfig(config: LockConfig): LockConfig {
	assertValidConfig(config);
	return config;
}

/** Store factory helpers, named the way a config names them. */
export const stores = {
	/** In-process only. Not a distributed lock — see {@link MemoryStore}. */
	memory(): StoreFactory {
		return () => new MemoryStore();
	},
	/**
	 * Either hand it a client, or name a quasar connection — the shape a
	 * store config takes everywhere else in the cohort, where the Redis module
	 * owns the socket. Naming a connection loads `@c9up/quasar` on the first
	 * lock, so a memory-only app never pays for it.
	 */
	redis(
		options:
			| ({ client: LockRedisClient } & RedisStoreOptions)
			| ({ connection?: string } & RedisStoreOptions),
	): StoreFactory {
		if ("client" in options) {
			return () => new RedisStore(options.client, options);
		}
		return () => new RedisStore(quasarConnection(options.connection), options);
	},
};

/** One store, with the defaults locks created from it inherit. */
export class LockFactory {
	readonly #store: LockStore;
	readonly #config: ResolvedLockConfig;

	constructor(store: LockStore, options?: LockFactoryOptions) {
		this.#store = store;
		this.#config = resolveConfig(options);
	}

	/** The store this factory leases from. */
	getStore(): LockStore {
		return this.#store;
	}

	/**
	 * A lock on `key`, not yet acquired.
	 *
	 * `ttl` is how long the lease survives WITHOUT being released — a crash
	 * recovery bound, not an estimate of how long the work takes. Size it so a
	 * dead holder frees the key in an acceptable time, and call
	 * {@link Lock.extend} for work that legitimately runs longer.
	 */
	createLock(key: string, ttl?: Duration): Lock {
		return new Lock(
			key,
			this.#store,
			this.#config,
			undefined,
			resolveMs(ttl, this.#config.ttl),
		);
	}

	/**
	 * Rebuild a lock from {@link Lock.serialize}, so the lease can be held
	 * across a process boundary — taken by the request, released by the job it
	 * enqueued.
	 */
	restoreLock(serialized: SerializedLock): Lock {
		return new Lock(
			serialized.key,
			this.#store,
			this.#config,
			serialized.owner,
			serialized.ttl,
			serialized.expirationTime,
		);
	}
}

/**
 * The config's OWN store named `name`, or `undefined`.
 *
 * A plain `stores[name]` reads Object.prototype too, so `use('toString')`
 * would call an inherited function as a store factory and fail on the first
 * lock, far from the typo, instead of naming the store that does not exist.
 */
function ownStore(
	declared: Record<string, StoreFactory>,
	name: string,
): StoreFactory | undefined {
	if (!Object.hasOwn(declared, name)) return undefined;
	const factory = declared[name];
	return typeof factory === "function" ? factory : undefined;
}

function assertValidConfig(config: LockConfig): void {
	const declared: unknown = config.stores;
	if (typeof declared !== "object" || declared === null) {
		throw new InvalidConfigError('missing "stores" in the lock config');
	}
	const name: unknown = config.default;
	if (typeof name !== "string" || name === "") {
		throw new InvalidConfigError(
			'missing "default" store in the lock config (is LOCK_STORE set?)',
		);
	}
	if (ownStore(config.stores, name) === undefined) {
		throw new UnknownStoreError(name, Object.keys(config.stores));
	}
}

export class LockManager {
	readonly #config: LockConfig;
	readonly #built = new Map<string, LockFactory>();

	constructor(config: LockConfig) {
		assertValidConfig(config);
		this.#config = config;
	}

	/** Resolve a store by name (or the default). Built once, then reused. */
	use(name?: string): LockFactory {
		const store = name ?? this.#config.default;
		const existing = this.#built.get(store);
		if (existing) return existing;

		const factory = ownStore(this.#config.stores, store);
		if (!factory) {
			throw new UnknownStoreError(store, Object.keys(this.#config.stores));
		}
		const built = new LockFactory(factory(), {
			retry: this.#config.retry,
			ttl: this.#config.ttl,
		});
		this.#built.set(store, built);
		return built;
	}

	/** {@link LockFactory.createLock} on the default store. */
	createLock(key: string, ttl?: Duration): Lock {
		return this.use().createLock(key, ttl);
	}

	/** {@link LockFactory.restoreLock} on the default store. */
	restoreLock(serialized: SerializedLock): Lock {
		return this.use().restoreLock(serialized);
	}

	/**
	 * Release what every BUILT store owns.
	 *
	 * Stores are created on first use, so this reaches the ones the
	 * application actually asked for — naming a Redis store in an environment
	 * that runs on memory still opens nothing. A store handed an existing
	 * client implements nothing here: closing a connection eclipse did not
	 * open would break whoever else is on it.
	 */
	async disconnectAll(): Promise<void> {
		await Promise.all(
			[...this.#built.values()].map((factory) =>
				factory.getStore().disconnect?.(),
			),
		);
	}
}

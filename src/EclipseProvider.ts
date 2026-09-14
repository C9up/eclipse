/**
 * EclipseProvider — publishes a {@link LockManager} built from `config/lock.ts`.
 *
 *   // reamrc.ts
 *   providers: [() => import('@c9up/eclipse/provider')]
 *
 *   // config/lock.ts
 *   export default defineConfig({
 *     default: 'memory',
 *     stores: { memory: stores.memory() },
 *   })
 */

import "./augmentations.js";
import { type LockConfig, LockManager, stores } from "./LockManager.js";
import { clearLocks, getLocks, setLocks } from "./services/main.js";

/**
 * Duck-typed host context — eclipse stays publishable without importing
 * `@c9up/ream`. Any framework exposing a container and a config store
 * satisfies it.
 */
interface EclipseContainer {
	singleton(token: unknown, factory: () => unknown): void;
	/**
	 * `unknown`, not a generic `resolve<T>`.
	 *
	 * A `resolve<T>(token): Promise<T>` cannot be implemented without an
	 * unchecked cast — it promises a type nothing verified — so every host and
	 * every fake would have to lie to the compiler to satisfy it. Returning
	 * `unknown` puts the check where it belongs: {@link EclipseProvider} asks
	 * whether what came back is really a {@link LockManager}. The real ream
	 * container's generic signature still satisfies this.
	 */
	resolve(token: unknown): Promise<unknown>;
}
interface EclipseConfigStore {
	/** Same reasoning: the shape is validated here, not asserted by the caller. */
	get(key: string): unknown;
}
export interface EclipseAppContext {
	container: EclipseContainer;
	config: EclipseConfigStore;
}

function isLockConfig(value: unknown): value is LockConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		"stores" in value &&
		"default" in value
	);
}

export default class EclipseProvider {
	constructor(protected app: EclipseAppContext) {}

	/**
	 * The manager the container holds, checked rather than asserted.
	 *
	 * The container answers `unknown` by design (see {@link EclipseContainer}),
	 * so this is where it becomes a {@link LockManager} — and a host that
	 * rebound the token to something else is told so here instead of failing
	 * on the first `createLock`.
	 */
	async #resolveManager(): Promise<LockManager> {
		const resolved = await this.app.container.resolve(LockManager);
		if (!(resolved instanceof LockManager)) {
			throw new Error(
				"[eclipse] the container returned something that is not a LockManager for the LockManager token.",
			);
		}
		return resolved;
	}

	register(): void {
		this.app.container.singleton(LockManager, () => {
			const raw = this.app.config.get("lock");
			// No config file is not a failure: a single-process application
			// locking in memory is a legitimate default, and it is what the
			// scheduler falls back to. What IS worth refusing is a config that
			// exists but is not a lock config — that is a typo in a file the
			// author believed was being read.
			if (raw === undefined) {
				return new LockManager({
					default: "memory",
					stores: { memory: stores.memory() },
				});
			}
			if (!isLockConfig(raw)) {
				throw new Error(
					"[eclipse] config/lock.ts must export defineConfig({ default, stores }).",
				);
			}
			return new LockManager(raw);
		});
		// Namespaced by the package that owns it, the way the rest of the
		// cohort namespaces `echo.cache` and `lucid.db`. The bare token stays
		// bound beside it: it is what a `container.make('lock')` asks for.
		const manager = (): Promise<LockManager> => this.#resolveManager();
		this.app.container.singleton("eclipse.lock", manager);
		this.app.container.singleton("lock", manager);
	}

	/** The manager THIS provider opened — not whatever the module singleton holds. */
	#locks: LockManager | undefined;

	/**
	 * Publish on `services/main` at BOOT.
	 *
	 * It has to be here rather than in `ready`: the HTTP socket opens before
	 * the providers are readied, so a manager published later leaves a window
	 * where a request reaches a controller and the accessor throws. Building
	 * it opens nothing — a store's connection is resolved on the first lock.
	 */
	async boot(): Promise<void> {
		this.#locks = await this.#resolveManager();
		setLocks(this.#locks);
	}

	/** Release what the stores own — nothing, for a store on an injected client. */
	async shutdown(): Promise<void> {
		if (!this.#locks) return;
		await this.#locks.disconnectAll();
		// Two applications can share a process — parallel tests, a hot reload.
		// The module singleton holds whichever booted last, so it is only ours
		// to clear while it still points at the manager this provider booted.
		if (getLocks() === this.#locks) clearLocks();
		this.#locks = undefined;
	}
}

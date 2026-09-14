/**
 * Teach ream's `ContainerBindings` what `container.make(...)` returns for the
 * tokens eclipse binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Without this,
 * resolving by the string token answers `unknown` and every call site has to
 * assert a type it cannot prove.
 *
 * Loaded from the package barrel, so importing eclipse anywhere in the
 * application is enough — nobody writes a `declare module` of their own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import, and a `declare module` for a specifier that does not resolve is
 * simply inert.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";

import type { LockManager } from "./LockManager.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The lock manager, bound by `EclipseProvider`. */
		"eclipse.lock": LockManager;
		/** The same binding under the bare role name. */
		lock: LockManager;
	}
}

/**
 * `ream configure @c9up/eclipse` — wire the locks in one command.
 *
 * The provider alone is not enough: it reads `config/lock.ts`, and a package
 * registered without one falls back to an in-process store that bounds
 * nothing across replicas. Writing both together is what makes `ream add`
 * mean installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		LOCK_STORE: "memory",
	});

	await codemods.addProvider("@c9up/eclipse/provider");
	await codemods.writeFile(
		"config/lock.ts",
		`import { defineConfig, stores } from '@c9up/eclipse'
import env from '#start/env'

export default defineConfig({
  default: env.get('LOCK_STORE', 'memory'),

  stores: {
    // In this process only. Two replicas each keep their own map and will
    // both take the same key — for a single-process deployment and tests.
    memory: stores.memory(),

    // Shared. What a second replica needs; names a @c9up/quasar connection,
    // resolved on the first lock.
    redis: stores.redis({ connection: 'main' }),
  },
})`,
	);
}

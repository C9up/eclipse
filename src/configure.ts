/**
 * `ream configure @c9up/eclipse` — wire the locks in one command.
 *
 * The provider alone is not enough: it reads `config/lock.ts`, and refuses to
 * boot without one. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
	/** Absent from a ream older than the hook; the rule is then added by hand. */
	defineEnvValidations?(definition: {
		leadingComment?: string;
		variables: Record<string, string>;
	}): Promise<string[]>;
}

/**
 * The store a fresh application deploys with.
 *
 * The shared one, never memory: an in-process store locks nothing across
 * replicas. Redis is eclipse's only distributed store, so there is nothing
 * to choose between; memory stays declared in the config for tests.
 */
const STORE = "redis";

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads this, so it is declared here. Writing the file
	// without it leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({ LOCK_STORE: STORE });

	// A typo such as LOCK_STORE=redsi then fails at env validation, where the
	// variable is named, rather than as an unknown store at boot.
	await codemods.defineEnvValidations?.({
		leadingComment: "Variables for configuring the lock package",
		variables: {
			LOCK_STORE: `Env.schema.enum(['${STORE}', 'memory'] as const)`,
		},
	});

	await codemods.addProvider("@c9up/eclipse/provider");
	await codemods.makeUsingStub(stubsRoot, "config/lock.stub");
}

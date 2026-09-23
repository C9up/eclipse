/**
 * `ream configure @c9up/eclipse` — wire the locks in one command.
 *
 * The provider alone is not enough: it reads `config/lock.ts`, and a package
 * registered without one falls back to an in-process store that bounds
 * nothing across replicas. Writing both together is what makes `ream add`
 * mean installed AND working.
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
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		LOCK_STORE: "memory",
	});

	await codemods.addProvider("@c9up/eclipse/provider");
	await codemods.makeUsingStub(stubsRoot, "config/lock.stub");
}

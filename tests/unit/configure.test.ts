import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function codemods() {
	const written = new Map<string, string>();
	return {
		addProvider: vi.fn().mockResolvedValue(undefined),
		addEnvVars: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn(async (path: string, content: string) => {
			written.set(path, content);
		}),
		makeUsingStub: vi.fn(
			async (
				stubsRoot: string,
				stubPath: string,
				state: Record<string, string | number | boolean> = {},
			) => {
				const { to, body } = renderStub(stubsRoot, stubPath, state);
				written.set(to, body);
				return { path: to, contents: body };
			},
		),
		written,
	};
}

describe("configure", () => {
	it("registers the provider and points LOCK_STORE at the shared store", async () => {
		const c = codemods();
		await configure(c);
		expect(c.addProvider).toHaveBeenCalledWith("@c9up/eclipse/provider");
		// The in-process store locks nothing across replicas, so it is not
		// what a freshly configured application deploys with.
		expect(c.addEnvVars).toHaveBeenCalledWith({ LOCK_STORE: "redis" });
	});

	it("declares LOCK_STORE's validation, so a typo fails at env validation", async () => {
		const defineEnvValidations = vi.fn().mockResolvedValue([]);
		await configure({ ...codemods(), defineEnvValidations });
		expect(defineEnvValidations).toHaveBeenCalledWith({
			leadingComment: expect.any(String),
			variables: {
				LOCK_STORE: "Env.schema.enum(['redis', 'memory'] as const)",
			},
		});
	});

	it("still configures on a host without the env validation codemod", async () => {
		const c = codemods();
		await expect(configure(c)).resolves.toBeUndefined();
		expect(c.written.has("config/lock.ts")).toBe(true);
	});

	it("writes a config in the multi-store shape the manager reads", async () => {
		const c = codemods();
		await configure(c);
		const config = c.written.get("config/lock.ts") ?? "";
		expect(config).toContain("defineConfig({");
		expect(config).toContain("stores: {");
		expect(config).toContain("stores.memory()");
		expect(config).toContain("stores.redis({ connection: 'main' })");
	});

	it("reads the default store from the environment with no silent fallback", async () => {
		const c = codemods();
		await configure(c);
		const config = c.written.get("config/lock.ts") ?? "";
		expect(config).toContain("default: env.get('LOCK_STORE'),");
		expect(config).not.toContain("env.get('LOCK_STORE', ");
	});
});

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
	it("registers the provider and declares the env vars its config reads", async () => {
		const c = codemods();
		await configure(c);
		expect(c.addProvider).toHaveBeenCalledWith("@c9up/eclipse/provider");
		expect(c.addEnvVars).toHaveBeenCalledWith({ LOCK_STORE: "memory" });
	});

	it("writes a config in the multi-store shape the manager reads", async () => {
		const c = codemods();
		await configure(c);
		const config = c.written.get("config/lock.ts") ?? "";
		expect(config).toContain("defineConfig({");
		expect(config).toContain("stores: {");
		expect(config).toContain("stores.memory()");
		expect(config).toContain("stores.redis({ connection: 'main' })");
		expect(config).toContain("LOCK_STORE");
	});
});

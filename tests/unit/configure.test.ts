import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";

function codemods() {
	const written = new Map<string, string>();
	return {
		addProvider: vi.fn().mockResolvedValue(undefined),
		addEnvVars: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn(async (path: string, content: string) => {
			written.set(path, content);
		}),
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

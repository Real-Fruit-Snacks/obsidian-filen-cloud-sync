import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// Engine/state/log import obsidian; tests substitute a minimal mock.
			obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		// Pure-JS Argon2id (auth v3 tests) is CPU-heavy — well above the 5s
		// vitest default on slow/loaded machines.
		testTimeout: 20000,
	},
});

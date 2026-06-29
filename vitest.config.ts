import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["node_modules", ".reference", "dist", "out"],
		include: ["src/**/*.test.ts", "test/**/*.ts"],
	},
});

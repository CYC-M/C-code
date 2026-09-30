import { fileURLToPath } from "node:url";
import baseConfig from "../../vitest.base.ts";
import { defineConfig, mergeConfig } from "vitest/config";

const codingAgentIndex = fileURLToPath(new URL("../../packages/coding-agent/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["extensions/c-code/src/**/*.test.ts"],
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentIndex }],
		},
	}),
);

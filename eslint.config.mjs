import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// debug.ts IS the opt-in debug logger: console output is its entire
		// purpose, gated behind the "Debug log" setting and silent by default.
		files: ["src/debug.ts"],
		rules: {
			"obsidianmd/rule-custom-message": "off",
		},
	},
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"dist/**",
			"tests/**",
			"scripts/**",
			"esbuild.config.mjs",
			"vitest.config.ts",
		],
	},
];

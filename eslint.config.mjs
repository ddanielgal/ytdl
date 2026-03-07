import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const tsRecommended = tsPlugin.configs["flat/recommended"](tsPlugin, tsParser);

export default [
  js.configs.recommended,
  ...tsRecommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/", "ytdl", "dist/", "*.config.mjs", "*.config.ts", "bun.lock"],
  },
];

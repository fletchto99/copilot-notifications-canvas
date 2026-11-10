import js from "@eslint/js";
import globals from "globals";
import { builtinModules } from "node:module";

const browserImports = ["node:*", ...builtinModules, "**/provider/**", "**/extension.mjs"];

export default [
  { ignores: ["node_modules/**", "dist/**", "playwright-report/**", "test-results/**", "coverage/**", "**/artifacts/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    ignores: ["src/renderer/**/*.mjs", "src/shared/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/renderer/**/*.mjs"],
    languageOptions: { globals: globals.browser },
    rules: { "no-restricted-imports": ["error", { patterns: browserImports }] },
  },
  {
    files: ["src/shared/**/*.mjs"],
    languageOptions: { globals: { URL: "readonly", URLSearchParams: "readonly" } },
    rules: { "no-restricted-imports": ["error", { patterns: [...browserImports, "**/renderer/**"] }] },
  },
  {
    files: ["src/provider/**/*.mjs"],
    rules: { "no-restricted-imports": ["error", { patterns: ["**/renderer/**"] }] },
  },
  {
    files: ["test/browser/*.spec.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/**/*.mjs", ".github/extensions/github-notifications/*.mjs"],
    rules: { "no-console": "error" },
  },
];

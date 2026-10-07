import js from "@eslint/js";
import globals from "globals";

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
    ignores: ["src/app.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/app.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["test/browser/*.spec.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/*.mjs", ".github/extensions/github-notifications/*.mjs"],
    rules: { "no-console": "error" },
  },
];

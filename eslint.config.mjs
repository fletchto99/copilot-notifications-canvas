import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "coverage/**", "**/artifacts/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.mjs"],
    ignores: [".github/extensions/github-notifications/{app,sound}.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: [".github/extensions/github-notifications/{app,sound}.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["test/browser/*.spec.mjs"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [".github/extensions/github-notifications/*.mjs"],
    rules: { "no-console": "error" },
  },
];

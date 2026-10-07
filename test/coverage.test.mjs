import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { assertCoverageIncludes } from "../scripts/coverage-reporter.mjs";

test("coverage cannot silently omit unexecuted runtime files or count tests in their place", () => {
  const expected = ["extension.mjs", "app.mjs"];
  assert.doesNotThrow(() => assertCoverageIncludes(expected.map(path => ({ path: resolve(path) })), expected));
  assert.throws(() => assertCoverageIncludes([{ path: "test/extension.test.mjs" }, { path: "app.mjs" }], expected),
    /Source files missing from coverage:\nextension\.mjs/);
  assert.throws(() => assertCoverageIncludes([], expected), /extension\.mjs\napp\.mjs/);
});

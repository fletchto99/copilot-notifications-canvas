import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCoverageIncludes } from "../scripts/coverage-reporter.mjs";

test("the coverage command enforces at least 95% aggregate coverage and checks source-file inclusion", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const command = manifest.scripts["test:coverage"];
  for (const metric of ["lines", "branches", "functions"]) {
    const threshold = command.match(new RegExp(`--test-coverage-${metric}=(\\d+)(?:\\s|$)`));
    assert.ok(threshold && Number(threshold[1]) >= 95, `The ${metric} coverage gate must be at least 95%`);
  }
  assert.match(command, /--test-reporter=\.\/scripts\/coverage-reporter\.mjs(?:\s|$)/);
});

test("coverage cannot silently omit unexecuted runtime files or count tests in their place", () => {
  const expected = ["extension.mjs", "app.mjs"];
  assert.doesNotThrow(() => assertCoverageIncludes(expected.map(path => ({ path: resolve(path) })), expected));
  assert.throws(() => assertCoverageIncludes([{ path: "test/extension.test.mjs" }, { path: "app.mjs" }], expected),
    /Source files missing from coverage:\nextension\.mjs/);
  assert.throws(() => assertCoverageIncludes([], expected), /extension\.mjs\napp\.mjs/);
});

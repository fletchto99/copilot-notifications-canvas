import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("browser CI pins the locked Playwright version without installing browsers or system packages", async () => {
  const [workflow, lock] = await Promise.all([
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.ok(workflow.includes("\n  browser:"));
  const browser = workflow.slice(workflow.indexOf("\n  browser:"));
  const image = browser.match(/^\s+image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[a-f0-9]{64}$/m);
  assert.ok(image, "Browser CI must use a version- and digest-pinned Playwright image");
  assert.equal(image[1], lock.packages["node_modules/@playwright/test"].version);
  assert.match(browser, /git config --global --add safe\.directory "\$GITHUB_WORKSPACE"/);
  assert.match(browser, /git rev-parse --verify HEAD/);
  assert.match(browser, /browser: \[chromium, webkit\]/);
  assert.match(browser, /npm run test:browser -- --project="\$\{\{ matrix\.browser \}\}"/);
  assert.doesNotMatch(browser, /playwright install|apt-get/);
});

test("Copilot cloud sessions and reviews share lightweight setup without browser provisioning", async () => {
  const setup = await readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8");
  assert.match(setup, /\njobs:\n {2}copilot-setup-steps:/);
  assert.match(setup, /npm ci --ignore-scripts --no-fund --no-audit/);
  assert.match(setup, /actionlint --version/);
  assert.doesNotMatch(setup, /playwright install|apt-get|npm run (?:test|build)/);
  await assert.rejects(readFile(new URL("../.github/workflows/copilot-code-review.yml", import.meta.url)), { code: "ENOENT" });
});

test("local tooling selects the primary CI Node major and full validation cannot skip prerequisites or browser engines", async () => {
  const [node, setup, workflow, manifest] = await Promise.all([
    readFile(new URL("../.node-version", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(node.trim(), /^\d+$/);
  assert.ok(setup.includes(`node-version: "${node.trim()}"`));
  assert.ok(workflow.includes(`node: "${node.trim()}"`));
  assert.deepEqual(manifest.scripts["check:full"].split(" && "), [
    "npm run doctor", "npm run lint", "npm run lint:workflows", "npm run test:coverage",
    "npm run build", "npm run test:package", "npm run test:browser -- --project=chromium --project=webkit",
  ]);
  assert.equal(manifest.scripts["dev:fixture"], "node scripts/dev-fixture.mjs");
  assert.equal(manifest.scripts.doctor, "node scripts/doctor.mjs");
});

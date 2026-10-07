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
  assert.match(browser, /browser: \[chromium, webkit\]/);
  assert.match(browser, /npm run test:browser -- --project="\$\{\{ matrix\.browser \}\}"/);
  assert.doesNotMatch(browser, /playwright install|apt-get/);
});

test("Copilot reviews use lightweight setup while cloud sessions retain browser tooling", async () => {
  const [review, cloud] = await Promise.all([
    readFile(new URL("../.github/workflows/copilot-code-review.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8"),
  ]);
  assert.match(review, /\njobs:\n {2}copilot-setup-steps:/);
  assert.match(review, /npm ci --ignore-scripts --no-fund --no-audit/);
  assert.match(review, /actionlint --version/);
  assert.doesNotMatch(review, /playwright install|apt-get|npm run (?:test|build)/);
  assert.match(cloud, /npx playwright install --with-deps chromium webkit/);
});

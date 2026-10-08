import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("CI runs ESLint, Stylelint and Prettier checks without allowing warnings", async () => {
  const [workflow, { scripts }] = await Promise.all([
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const lint = workflow.match(/\n {2}lint:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:|$)/)?.[1];
  assert.ok(lint, "CI must have a lint job");
  for (const script of ["lint:js", "lint:css", "format:css:check", "lint:recovery"]) {
    assert.match(lint, new RegExp(`^\\s+run: npm run ${script}$`, "m"));
  }
  assert.equal(scripts.lint, "npm run lint:js && npm run lint:css && npm run format:css:check && npm run lint:recovery");
  assert.equal(scripts["lint:js"], "eslint . --max-warnings=0");
  assert.equal(scripts["lint:css"], 'stylelint "src/**/*.css" --max-warnings=0');
  assert.equal(scripts["format:css:check"], 'prettier --check "src/**/*.css"');
  assert.equal(scripts["lint:recovery"], "node --test test/recovery-lint.integration.mjs");
  assert.equal(scripts.test, "node --test test/*.test.mjs");
});

test("browser CI pins the locked Playwright version without installing browsers or system packages", async () => {
  const [workflow, lock] = await Promise.all([
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.ok(workflow.includes("\n  browser:"));
  const browser = workflow.slice(workflow.indexOf("\n  browser:"));
  assert.match(browser, /runs-on: ubuntu-latest/);
  const image = browser.match(/^\s+image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[a-f0-9]{64}$/m);
  assert.ok(image, "Browser CI must use a version- and digest-pinned Playwright image");
  assert.equal(image[1], lock.packages["node_modules/@playwright/test"].version);
  assert.match(browser, /git config --global --add safe\.directory "\$GITHUB_WORKSPACE"/);
  assert.match(browser, /git rev-parse --verify HEAD/);
  assert.match(browser, /browser: \[chromium, webkit\]/);
  assert.match(browser, /npm run test:browser -- --project="\$\{\{ matrix\.browser \}\}"/);
  assert.doesNotMatch(browser, /playwright install|apt-get/);
});

test("CI uses the preferred Node version for tooling while preserving Node 22 runtime coverage", async () => {
  const [manifest, lock, preferredNode, tests, setup, release, build] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../.node-version", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-release.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(preferredNode.trim(), "24");
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
  const runtime = tests.match(/\n {2}test:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:|$)/)?.[1];
  assert.ok(runtime);
  assert.match(runtime, /node-version: \$\{\{ matrix\.node \}\}/);
  for (const job of ["windows", "lint", "browser"]) {
    const configuration = tests.match(new RegExp(`\\n {2}${job}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][\\w-]*:|$)`))?.[1];
    assert.ok(configuration, job);
    assert.match(configuration, /node-version-file: \.node-version/);
    assert.doesNotMatch(configuration, /^\s+node-version:/m);
  }
  assert.equal([...setup.matchAll(/^\s+- \.node-version$/gm)].length, 2);
  for (const workflow of [setup, release]) {
    const versionFiles = [...workflow.matchAll(/node-version-file: (\S+)/g)];
    assert.ok(versionFiles.length > 0);
    for (const [, versionFile] of versionFiles) assert.equal(versionFile, ".node-version");
    assert.doesNotMatch(workflow, /^\s+node-version:/m);
  }
  for (const workflow of [tests, setup, release]) {
    const installs = workflow.match(/^\s+run: npm ci[^\n]+$/gm) ?? [];
    assert.ok(installs.length > 0);
    for (const command of installs) assert.match(command, / --engine-strict(?:\s|$)/);
  }
  assert.match(runtime, /node: "22"/);
  assert.match(runtime, /node: "24"/);
  assert.match(runtime, /if: matrix\.node == '22'\n\s+run: npm run test:coverage/);
  assert.match(build, /target: "node22"/);
});

test("Copilot cloud sessions and reviews share lightweight setup without browser provisioning", async () => {
  const setup = await readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8");
  assert.match(setup, /\njobs:\n {2}copilot-setup-steps:/);
  assert.match(setup, /runs-on: ubuntu-latest/);
  assert.match(setup, /npm ci --ignore-scripts --no-fund --no-audit --engine-strict/);
  assert.match(setup, /actionlint --version/);
  assert.doesNotMatch(setup, /playwright install|apt-get|npm run (?:test|build)/);
  await assert.rejects(readFile(new URL("../.github/workflows/copilot-code-review.yml", import.meta.url)), { code: "ENOENT" });
});

test("workflow lint uses a verbose Dependabot-managed local Docker action on a Docker-capable runner", async () => {
  const [workflow, action, dependabot] = await Promise.all([
    readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"),
    readFile(new URL("../ci/actionlint/action.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8"),
  ]);
  const job = id => {
    const match = workflow.match(new RegExp(`\\n {2}${id}:\\n([\\s\\S]*?)(?=\\n {2}[\\w-]+:|$)`));
    assert.ok(match, `Missing ${id} job`);
    return match[1];
  };
  const sourceLint = job("lint");
  assert.match(sourceLint, /name: Lint\n/);
  assert.match(sourceLint, /runs-on: ubuntu-slim/);
  assert.match(sourceLint, /npm run lint:js(?:\n|$)/);
  assert.doesNotMatch(sourceLint, /actionlint|curl|docker:\/\//);

  const actionlint = job("actionlint");
  assert.match(actionlint, /name: Actionlint\n/);
  assert.match(actionlint, /permissions:\n {6}contents: read/);
  assert.match(actionlint, /runs-on: ubuntu-latest/);
  assert.match(actionlint, /timeout-minutes: 5/);
  assert.match(actionlint, /uses: actions\/checkout@[a-f0-9]{40}/);
  assert.match(actionlint, /persist-credentials: false/);
  assert.match(actionlint, /uses: \.\/ci\/actionlint(?:\n|$)/);
  assert.ok(actionlint.indexOf("uses: actions/checkout@") < actionlint.indexOf("uses: ./ci/actionlint"));
  assert.doesNotMatch(actionlint, /npm|setup-node|curl|docker:\/\/|args:/);

  assert.match(action, /runs:\n {2}using: docker\n {2}image: Dockerfile\n {2}args:\n {4}- -color\n {4}- -verbose(?:\n|$)/);
  assert.doesNotMatch(action, /entrypoint:|shellcheck=|pyflakes=/);
  const docker = dependabot.match(/\n {2}- package-ecosystem: docker\n([\s\S]*?)(?=\n {2}- package-ecosystem:|$)/)?.[1];
  assert.ok(docker, "Dependabot must manage the Dockerfile actually consumed by CI");
  assert.match(docker, /directory: \/ci\/actionlint(?:\n|$)/);
  assert.match(docker, /schedule:\n {6}interval: weekly/);
});

test("the pinned actionlint Docker image, Copilot setup binary and installation guidance stay aligned", async () => {
  const [dockerfile, setup, doctor, development] = await Promise.all([
    readFile(new URL("../ci/actionlint/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/copilot-setup-steps.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/doctor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/development.md", import.meta.url), "utf8"),
  ]);
  const image = dockerfile.match(/^FROM rhysd\/actionlint:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}\n?$/);
  assert.ok(image, "The local Docker action must contain only the version- and digest-pinned upstream image");

  assert.ok(setup.includes(`/download/v${image[1]}/actionlint_${image[1]}_linux_amd64.tar.gz`),
    "Copilot setup and workflow CI must use the same actionlint version");
  assert.match(setup, /echo "[a-f0-9]{64} {2}\$RUNNER_TEMP\/actionlint\.tar\.gz" \| sha256sum --check/);
  assert.ok(setup.indexOf("sha256sum --check") < setup.indexOf("tar -xzf"));
  for (const content of [doctor, development]) {
    assert.ok(content.includes(`go install github.com/rhysd/actionlint/cmd/actionlint@v${image[1]}`),
      "Doctor remediation and development guidance must name the same actionlint version");
  }
});

test("local validation cannot skip prerequisites or browser engines and preserves preview entry points", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.scripts["check:full"].split(" && "), [
    "npm run doctor", "npm run lint", "npm run lint:workflows", "npm run test:coverage",
    "npm run build", "npm run test:package", "npm run test:browser -- --project=chromium --project=webkit",
  ]);
  assert.equal(manifest.scripts["dev:fixture"], "node scripts/dev-fixture.mjs");
  assert.equal(manifest.scripts.doctor, "node scripts/doctor.mjs");
});

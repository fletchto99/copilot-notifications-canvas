import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectEnvironment, runDoctor } from "../scripts/doctor.mjs";

const packageUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(packageUrl, "utf8"));

function tools(overrides = {}) {
  return {
    nodeVersion: "24.0.0",
    read: async url => {
      if (url.href === packageUrl.href) return JSON.stringify(manifest);
      const name = url.pathname.split("/node_modules/")[1].replace(/\/package\.json$/, "");
      assert.ok(Object.hasOwn(manifest.devDependencies, name));
      return JSON.stringify({ version: manifest.devDependencies[name] });
    },
    run: async (command, args, options) => {
      assert.equal(command, "actionlint");
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.timeout, 5000);
      return { stdout: "1.7.12\ninstalled by a package manager\n" };
    },
    loadBrowsers: async () => ({
      chromium: { executablePath: () => "/synthetic/chromium" },
      webkit: { executablePath: () => "/synthetic/webkit" },
    }),
    checkAccess: async (path, mode) => {
      assert.ok(["/synthetic/chromium", "/synthetic/webkit"].includes(path));
      assert.equal(mode, constants.X_OK);
    },
    ...overrides,
  };
}

test("doctor checks supported Node versions, pinned dependencies, actionlint and both browser paths", async () => {
  for (const nodeVersion of ["24.0.0", "26.0.0"]) {
    const checks = await inspectEnvironment(tools({ nodeVersion }));
    assert.equal(checks.length, Object.keys(manifest.devDependencies).length + 4);
    assert.ok(checks.every(check => check.ok));
    assert.deepEqual(checks.slice(-2).map(check => check.name), ["chromium executable", "webkit executable"]);
  }
  for (const nodeVersion of ["20.19.0", "22.23.1", "invalid"]) {
    const [node] = await inspectEnvironment(tools({ nodeVersion }));
    assert.equal(node.ok, false);
    assert.match(node.remedy, /\.node-version/);
  }
});

test("doctor reports missing, unreadable, malformed and mismatched packages without skipping other checks", async () => {
  for (const failure of [
    Object.assign(new Error("not found"), { code: "ENOENT" }),
    Object.assign(new Error("denied"), { code: "EACCES" }),
    new SyntaxError("malformed"),
    "0.0.0",
    undefined,
  ]) {
    const base = tools();
    const checks = await inspectEnvironment({
      ...base,
      read: async url => {
        if (url.href === packageUrl.href) return base.read(url);
        if (failure instanceof Error) throw failure;
        return JSON.stringify({ version: failure });
      },
    });
    const packages = checks.slice(1, -3);
    assert.equal(packages.length, Object.keys(manifest.devDependencies).length);
    assert.ok(packages.every(check => !check.ok && check.remedy === "npm ci --ignore-scripts --engine-strict"));
    assert.ok(checks.slice(-3).every(check => check.ok));
  }
});

test("doctor diagnoses failed or unrecognized actionlint commands without copying command output", async () => {
  for (const failure of [Object.assign(new Error("private stderr"), { code: "ENOENT" }), new Error("private stderr"), "private stdout"]) {
    const checks = await inspectEnvironment(tools({
      run: async () => {
        if (failure instanceof Error) throw failure;
        return { stdout: failure };
      },
    }));
    const check = checks.find(check => check.name === "actionlint");
    assert.equal(check.ok, false);
    assert.match(check.remedy, /actionlint@v1\.7\.12/);
    assert.doesNotMatch(JSON.stringify(checks), /private/);
  }
});

test("doctor distinguishes unavailable Playwright inspection from missing or non-executable browsers", async () => {
  for (const error of [Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }), new Error("unavailable")]) {
    const checks = await inspectEnvironment(tools({ loadBrowsers: async () => { throw error; } }));
    assert.equal(checks.at(-1).name, "Playwright browsers");
    assert.equal(checks.at(-1).ok, false);
    assert.match(checks.at(-1).remedy, /npm ci --ignore-scripts --engine-strict, then npx playwright install/);
  }
  for (const error of [
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    Object.assign(new Error("not executable"), { code: "EACCES" }),
    new Error("unavailable"),
  ]) {
    const checks = await inspectEnvironment(tools({ checkAccess: async path => {
      if (path.endsWith("webkit")) throw error;
    } }));
    assert.equal(checks.at(-2).ok, true);
    assert.equal(checks.at(-1).ok, false);
    assert.equal(checks.at(-1).remedy, "npx playwright install --with-deps chromium webkit");
  }
});

test("doctor rejects unreadable manifests and unsupported engine syntax instead of assuming success", async () => {
  await assert.rejects(inspectEnvironment(tools({ read: async () => "{" })), SyntaxError);
  await assert.rejects(inspectEnvironment(tools({ read: async () =>
    JSON.stringify({ ...manifest, engines: { node: "^22" } }) })), /Unsupported Node engine range/);
});

test("doctor returns a failing exit status with remediation and explicit limits", async () => {
  for (const ok of [true, false]) {
    let output = "";
    const status = await runDoctor({
      inspect: async () => [{ name: "example", ok, detail: "checked", remedy: "repair command" }],
      write: text => { output += text; },
    });
    assert.equal(status, ok ? 0 : 1);
    assert.ok(output.startsWith(`${ok ? "OK" : "FAIL"} example: checked\n`));
    assert.equal(output.includes("Fix: repair command"), !ok);
    assert.match(output, /Read-only check/);
    assert.match(output, /do not verify system libraries or headless launch readiness/);
  }
});

test("doctor CLI is read-only, needs no GitHub credentials, and fails for missing tools or unknown arguments", async t => {
  const home = await mkdtemp(join(tmpdir(), "notification-doctor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/doctor.mjs", import.meta.url));
  const options = {
    env: { ...process.env, PATH: home, HOME: home, COPILOT_HOME: home, PLAYWRIGHT_BROWSERS_PATH: home },
    timeout: 15_000,
  };
  await assert.rejects(promisify(execFile)(process.execPath, [script], options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /FAIL actionlint/);
    assert.match(error.stdout, /FAIL webkit executable|FAIL Playwright browsers/);
    assert.match(error.stdout, /Read-only check/);
    assert.equal(error.stderr, "");
    return true;
  });
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--install"], options), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage: npm run doctor/);
    assert.equal(error.stdout, "");
    return true;
  });
  assert.deepEqual(await readdir(home), []);
});

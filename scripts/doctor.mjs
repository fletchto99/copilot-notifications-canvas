import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const installDependencies = "npm ci --ignore-scripts";
const installBrowsers = "npx playwright install --with-deps chromium webkit";
const installActionlint = "go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 (requires Go and its bin directory on PATH); see docs/development.md#environment-check for alternatives.";

export async function inspectEnvironment({
  nodeVersion = process.versions.node, read = readFile, run = promisify(execFile),
  loadBrowsers = () => import("@playwright/test"), checkAccess = access,
} = {}) {
  const manifest = JSON.parse(await read(new URL("../package.json", import.meta.url), "utf8"));
  const minimum = /^>=(\d+)$/.exec(manifest.engines.node);
  if (!minimum) throw new Error("Unsupported Node engine range in package.json.");
  const checks = [{
    name: "Node.js", ok: Number(nodeVersion.split(".")[0]) >= Number(minimum[1]),
    detail: `${nodeVersion} (requires ${manifest.engines.node})`,
    remedy: "Select the Node.js major in .node-version with your version manager, then rerun npm run doctor.",
  }];
  for (const [name, expected] of Object.entries(manifest.devDependencies)) {
    try {
      const installed = JSON.parse(await read(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"));
      checks.push({ name, ok: installed.version === expected,
        detail: `${installed.version ?? "unknown version"} (expected ${expected})`, remedy: installDependencies });
    } catch (error) {
      checks.push({ name, ok: false, detail: `Cannot read installed package (${error.code ?? error.name})`,
        remedy: installDependencies });
    }
  }
  try {
    const { stdout } = await run("actionlint", ["--version"], { timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const version = /^v?\d+\.\d+\.\d+\b/.exec(stdout);
    checks.push({ name: "actionlint", ok: Boolean(version), detail: version?.[0] ?? "Unrecognized version output",
      remedy: installActionlint });
  } catch (error) {
    checks.push({ name: "actionlint", ok: false, detail: `Cannot run actionlint --version (${error.code ?? error.name})`,
      remedy: installActionlint });
  }
  let browsers;
  try {
    browsers = await loadBrowsers();
  } catch (error) {
    checks.push({ name: "Playwright browsers", ok: false, detail: `Cannot inspect browser paths (${error.code ?? error.name})`,
      remedy: `${installDependencies}, then ${installBrowsers}` });
    return checks;
  }
  for (const name of ["chromium", "webkit"]) {
    try {
      await checkAccess(browsers[name].executablePath(), constants.X_OK);
      checks.push({ name: `${name} executable`, ok: true, detail: "Installed" });
    } catch (error) {
      checks.push({ name: `${name} executable`, ok: false, detail: `Browser executable unavailable (${error.code ?? error.name})`,
        remedy: installBrowsers });
    }
  }
  return checks;
}

export async function runDoctor({ inspect = inspectEnvironment, write = text => process.stdout.write(text) } = {}) {
  const checks = await inspect();
  for (const check of checks) {
    write(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}\n`);
    if (!check.ok) write(`  Fix: ${check.remedy}\n`);
  }
  write("Read-only check: no tools installed, browsers launched, GitHub authentication checked, or user settings changed.\n");
  write("Browser paths do not verify system libraries or headless launch readiness; run npm run test:browser to verify both engines.\n");
  return checks.every(check => check.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: npm run doctor (no arguments).");
    process.exitCode = await runDoctor();
  } catch (error) {
    process.stderr.write(`Environment inspection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

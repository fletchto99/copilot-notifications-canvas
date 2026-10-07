import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CURRENT_VERSION } from "../.github/extensions/github-notifications/updates.mjs";
import { encodeBundle, inspectBundle, loadPackage, verifyArchive } from "../scripts/package.mjs";
import { home } from "./install-fixtures.mjs";

const execute = promisify(execFile);
const tag = `v${CURRENT_VERSION}`;

test("the published archive installs and upgrades a self-contained provider with working minified assets", { timeout: 60_000 }, async t => {
  const root = await home(t);
  const directory = join(root, "package");
  const copilotHome = join(root, "copilot");
  await mkdir(directory);
  const [archive] = await verifyArchive(resolve("dist"), tag);
  const listing = await execute("tar", ["-tzf", archive]);
  assert.deepEqual(listing.stdout.trim().split("\n").sort(), ["extension.mjs", "install.mjs", "release.json"]);
  await execute("tar", ["-xzf", archive, "-C", directory]);
  const bundle = await loadPackage(directory, tag);
  const installer = join(directory, "install.mjs");
  const env = { ...process.env, COPILOT_HOME: copilotHome };
  const installed = await execute(process.execPath, [installer, tag], { env, cwd: root });
  assert.match(installed.stdout, new RegExp(`Installed v${CURRENT_VERSION.replaceAll(".", "\\.")}`));
  const target = join(copilotHome, "extensions", "github-notifications");
  const entry = join(target, "extension.mjs");
  assert.deepEqual(await readdir(target), ["extension.mjs"]);
  assert.equal(inspectBundle(await readFile(entry)).version, CURRENT_VERSION);
  assert.equal((await execute(process.execPath, [installer, tag], { env, cwd: root })).stdout.startsWith("Already current:"), true);
  await symlink(directory, join(root, "package-link"), "junction");
  assert.equal((await execute(process.execPath, [join(root, "package-link", "install.mjs"), tag],
    { env, cwd: root })).stdout.startsWith("Already current:"), true);

  // Model an already-running previous packaged release, not the unsupported legacy layout.
  const text = bundle.content.toString("utf8");
  const code = text.slice(text.indexOf("\n") + 1)
    .replaceAll("Unread Notifications", "Previous Notifications")
    .replaceAll(JSON.stringify(CURRENT_VERSION), '"0.0.0"');
  assert.notEqual(code, text.slice(text.indexOf("\n") + 1));
  await writeFile(entry, encodeBundle(code, "0.0.0"));
  const script = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { register, syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
const [root, installer, entry, version, renderer] = process.argv.slice(1);
const execute = promisify(childProcess.execFile);
const fakeGh = (command, args, options, callback) => {
  assert.equal(command, "gh", "A package smoke test must not invoke a native notifier or real service");
  assert.equal(args.at(-1), "/repos/fletchto99/copilot-notifications-canvas/releases/latest");
  callback(null, "HTTP/2 404 Not Found\\r\\n\\r\\n{}", "");
};
childProcess.execFile = fakeGh;
syncBuiltinESMExports();
const sdk = \`export const createCanvas = value => value;
export class CanvasError extends Error {}
export async function joinSession(options) {
  globalThis.testCanvases ??= [];
  globalThis.testCanvases.push(options.canvases[0]);
  return { workspacePath: process.argv[1],
    log(message) { throw new Error(message); } };
}\`;
const hook = \`export async function resolve(specifier, context, next) {
  if (specifier === "@github/copilot-sdk/extension") return {
    url: \${JSON.stringify("data:text/javascript," + encodeURIComponent(sdk))}, shortCircuit: true };
  return next(specifier, context);
}\`;
register("data:text/javascript," + encodeURIComponent(hook));
await import(pathToFileURL(entry).href);
const old = globalThis.testCanvases[0];
const panels = [];
async function open(canvas, id) {
  const result = await canvas.open({ instanceId: id, input: {} });
  panels.push([canvas, id]);
  const assets = {};
  for (const [route, file, type] of [
    ["/", "index.html", "text/html"], ["/app.mjs", "app.mjs", "text/javascript"], ["/styles.css", "styles.css", "text/css"]]) {
    const response = await fetch(new URL(route, result.url));
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(type));
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assets[file] = await response.text();
  }
  assert.equal((await fetch(new URL("/sound.mjs", result.url))).status, 404);
  const state = await canvas.actions.find(action => action.name === "get_state").handler({ instanceId: id });
  assert.ok(state);
  return { url: result.url, assets };
}
try {
  const before = await open(old, "before");
  assert.match(before.assets["index.html"], /<title>Previous Notifications<\\/title>/);
  const oldVersion = await old.actions.find(action => action.name === "check_for_updates").handler({ instanceId: "before" });
  assert.equal(oldVersion.currentVersion, "0.0.0");
  await execute(process.execPath, [installer, "v" + version], { env: process.env, cwd: root });
  await import(pathToFileURL(entry).href + "?new");
  const current = globalThis.testCanvases[1];
  assert.equal(current.id, "github-notifications");
  await rm(join(root, "package"), { recursive: true });
  const after = await open(current, "after");
  assert.match(after.assets["index.html"], /<title>Unread Notifications<\\/title>/);
  assert.deepEqual((await open(old, "old-opened-after-upgrade")).assets, before.assets);
  assert.equal(await (await fetch(new URL("/", before.url))).text(), before.assets["index.html"]);
  const state = await current.actions.find(action => action.name === "check_for_updates").handler({ instanceId: "after" });
  assert.equal(state.currentVersion, version);
  const settings = await current.actions.find(action => action.name === "get_settings").handler({ instanceId: "after" });
  assert.equal(settings.autoOpen, false);
  assert.equal(settings.desktopNotifications, false);
  assert.deepEqual((await readdir(new URL(".", pathToFileURL(entry)))).sort(), ["extension.mjs"]);
  const assetsDirectory = join(root, "served-assets");
  await mkdir(assetsDirectory);
  for (const [file, content] of Object.entries(after.assets)) await writeFile(join(assetsDirectory, file), content);
  const rendererEnv = { ...process.env, NOTIFICATIONS_TEST_SCRIPT: join(assetsDirectory, "app.mjs") };
  delete rendererEnv.NODE_TEST_CONTEXT;
  const result = await execute(process.execPath, ["--test", "--test-reporter=tap",
    "--test-name-pattern=renderer public controls survive bundling", renderer], {
    env: rendererEnv, timeout: 30_000,
  });
  assert.match(result.stdout, /# fail 0/);
  assert.match(result.stdout, /# pass 1/);
} finally {
  for (const [canvas, instanceId] of panels) await canvas.onClose({ instanceId });
}
`;
  const renderer = fileURLToPath(new URL("./renderer.test.mjs", import.meta.url));
  await execute(process.execPath, ["--input-type=module", "-e", script, root, installer, entry, CURRENT_VERSION, renderer],
    { env, cwd: root, timeout: 45_000, maxBuffer: 1024 * 1024 });
  assert.equal(inspectBundle(await readFile(entry)).version, CURRENT_VERSION);
  for (const file of ["app.mjs", "styles.css"]) {
    const built = await readFile(join(root, "served-assets", file));
    const source = await readFile(new URL(`../.github/extensions/github-notifications/${file}`, import.meta.url));
    assert.ok(built.length < source.length, `${file} must be minified`);
  }
});

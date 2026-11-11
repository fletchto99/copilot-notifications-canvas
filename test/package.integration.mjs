import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { list as listTar } from "tar";
import { CURRENT_VERSION } from "../src/provider/updates.mjs";
import { buildRelease, embeddedAssetsPlugin } from "../scripts/build-release.mjs";
import { encodeBundle, inspectBundle, loadPackage, verifyArchive } from "../scripts/package.mjs";
import { home } from "./install-fixtures.mjs";
import { startPackagedCanvas } from "./browser/package-fixtures.mjs";
import { createCanvasFixture } from "./canvas-fixtures.mjs";
import { githubMarkPNG } from "../src/provider/github-mark.mjs";

const execute = promisify(execFile);
const tag = `v${CURRENT_VERSION}`;

test("packaged browser teardown rejects an already-crashed provider and allows repeated clean closes", { timeout: 15_000 }, async t => {
  for (const crash of [false, true]) {
    await t.test(crash ? "provider killed before teardown" : "clean teardown", async t => {
      const root = await home(t);
      const fork = childProcess.fork;
      let child;
      t.mock.method(childProcess, "fork", (...args) => {
        child = fork(...args);
        return child;
      });
      syncBuiltinESMExports();
      try {
        const canvas = await startPackagedCanvas(root,
          async () => assert.fail("Teardown must not contact GitHub"),
          message => assert.fail(message));
        if (crash) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
          await assert.rejects(canvas.setTime(180_000), /disconnected packaged provider/);
          await assert.rejects(canvas.close(), /Packaged provider failed \(SIGKILL\)/);
        } else {
          await canvas.close();
          await canvas.close();
          assert.equal(child.exitCode, 0);
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});

test("test clocks preserve a pending discovery's retry deadline", async t => {
  for (const packaged of [false, true]) {
    await t.test(packaged ? "packaged provider" : "source provider", async t => {
      const canvas = await createCanvasFixture({ packaged, copilotEnabled: true });
      const discovery = Promise.withResolvers();
      t.after(async () => {
        discovery.resolve({ tools: [] });
        await canvas.close();
      });
      let calls = 0;
      canvas.copilotHost.rpc.getCurrentMetadata = async () => {
        calls++;
        return calls === 1 ? discovery.promise : { tools: [] };
      };
      const start = Date.now();
      await canvas.setCopilotTime(start);
      const url = new URL(canvas.url);
      const state = async () => {
        const response = await fetch(new URL("/api/state", url), {
          headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      await state();
      await t.waitFor(() => assert.equal(calls, 1));
      // Queue the clock update before the metadata response crosses the IPC boundary.
      discovery.resolve({ tools: [] });
      await canvas.setCopilotTime(start + 1000);
      await state();
      await t.waitFor(() => assert.equal(calls, 2), { timeout: 1000 });
      assert.deepEqual(canvas.copilotHost.calls, []);
      assert.deepEqual(canvas.writes, []);
    });
  }
});

test("archives reproduce the same bytes across output paths and filesystem umasks", async t => {
  const directory = await home(t);
  const previousMask = process.umask();
  let one;
  let two;
  try {
    process.umask(0o022);
    one = await buildRelease({ tag, directory: join(directory, "one") });
    process.umask(0o077);
    two = await buildRelease({ tag, directory: join(directory, "two") });
  } finally {
    process.umask(previousMask);
  }
  assert.deepEqual(await readFile(one), await readFile(two));
  const entries = [];
  await listTar({ file: one, onReadEntry: entry => {
    entries.push(entry.path);
    assert.equal(entry.type, "File");
    assert.equal(entry.mode, 0o644);
    assert.ok(!entry.uid && !entry.gid && !entry.uname && !entry.gname);
    assert.ok(!entry.mtime || entry.mtime.getTime() === 0);
  } });
  assert.deepEqual(entries, ["extension.mjs", "install.mjs", "release.json"]);
});

test("embedded assets round-trip through the JSON loader without becoming JavaScript", async () => {
  const samples = [
    'quotes: " \\ \' ` ${globalThis.notificationAssetExecuted = true}',
    '</script><script>globalThis.notificationAssetExecuted = true</script>',
    '"); globalThis.notificationAssetExecuted = true; //',
    "line\u2028separator\u2029paragraph",
    "control characters: \0\b\f\n\r\t",
    "lone surrogate: \ud800",
  ];
  const assets = samples.map((body, index) => [`/${index}`, { body, type: "text/plain" }]);
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/provider/assets.mjs", import.meta.url))],
    bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
    write: false, metafile: true, plugins: [embeddedAssetsPlugin(assets)],
  });
  assert.ok(Object.hasOwn(result.metafile.inputs, "notification-assets:assets"));
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports), []);
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  assert.deepEqual([...await module.loadAssets()], assets);
  assert.equal(await module.loadDevelopmentInfo(), null);
  assert.deepEqual([...module.assetPaths], assets.map(([path]) => path));
  assert.equal(globalThis.notificationAssetExecuted, undefined);
});

test("the bundled notifier attaches its embedded GitHub PNG without source assets or native delivery", async t => {
  const temporaryRoot = await home(t);
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/provider/notifier.mjs", import.meta.url))],
    bundle: true, platform: "node", format: "esm", target: "node22", minify: true, write: false,
  });
  const { notifyDesktop } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  let image;
  await notifyDesktop({
    title: "Synthetic title", body: "Synthetic body", platform: "darwin",
    terminalNotifier: "/synthetic/terminal-notifier", temporaryRoot,
    execute: (command, args, options, callback) => {
      assert.equal(command, "/synthetic/terminal-notifier");
      image = readFile(args[args.indexOf("-contentImage") + 1]);
      void image.then(() => callback(null), callback);
    },
  });
  assert.deepEqual(await image, githubMarkPNG);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test("the published archive installs and upgrades a self-contained provider with working minified assets", { timeout: 60_000 }, async t => {
  const root = await home(t);
  const directory = join(root, "package");
  const copilotHome = join(root, "copilot");
  await mkdir(directory);
  const [archive] = await verifyArchive(resolve("dist"), tag);
  const listing = await execute("tar", ["-tzf", archive]);
  assert.deepEqual(listing.stdout.trim().split(/\r?\n/).sort(), ["extension.mjs", "install.mjs", "release.json"]);
  await execute("tar", ["-xzf", archive, "-C", directory]);
  const bundle = await loadPackage(directory, tag);
  assert.ok(bundle.content.includes(githubMarkPNG.toString("base64")), "The release must embed the notification PNG.");
  const imageSource = await readFile(new URL("../src/provider/github-mark.mjs", import.meta.url), "utf8");
  const imageNotice = imageSource.replaceAll("\r\n", "\n").match(/\/\*![\s\S]*?\*\//)?.[0];
  assert.ok(imageNotice && bundle.content.includes(imageNotice), "The release must retain the GitHub mark's MIT license.");
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
    .replaceAll("GitHub Notifications", "Previous Notifications")
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
  return globalThis.testSession ?? { workspacePath: process.argv[1],
    on: () => () => {},
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
  const url = new URL(result.url);
  const readiness = await fetch(new URL("/api/ready", url), {
    headers: { Authorization: "Bearer " + url.hash.slice(1), Origin: url.origin },
  });
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { ready: true });
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
  assert.equal((await fetch(new URL("/model.mjs", result.url))).status, 404);
  assert.equal((await fetch(new URL("/shared/model.mjs", result.url))).status, 404);
  assert.equal((await fetch(new URL("/presentation.mjs", result.url))).status, 404);
  assert.equal((await fetch(new URL("/update-notice.mjs", result.url))).status, 404);
  const response = await fetch(new URL("/api/state", url), {
    headers: { Authorization: "Bearer " + url.hash.slice(1), Origin: url.origin },
  });
  assert.equal((await response.json()).development, null);
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
  assert.match(after.assets["index.html"], /<title>GitHub Notifications<\\/title>/);
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

  const preferences = join(process.env.COPILOT_HOME, "extensions", "github-notifications", "artifacts");
  await mkdir(preferences, { recursive: true });
  await writeFile(join(preferences, "settings.json"), '{"autoOpen":true}');
  const opens = [];
  const livePanels = [];
  const startupEvents = [
    { type: "session.start" }, { type: "user.message" }, { type: "assistant.message" },
    { type: "session.shutdown" }, { type: "session.resume" },
  ];
  globalThis.testSession = {
    workspacePath: join(root, "auto-open-session"),
    capabilities: { ui: { canvases: true } },
    log(message) { throw new Error(message); },
    on: () => () => {},
    getEvents: async () => startupEvents,
    rpc: { canvas: {
      list: async () => ({ canvases: [{
        extensionId: "user:github-notifications", canvasId: "github-notifications",
      }] }),
      listOpen: async () => ({ openCanvases: livePanels }),
      open: async input => {
        opens.push(input);
        const canvas = globalThis.testCanvases.at(-1);
        const result = await canvas.open(input);
        livePanels.push(input);
        panels.push([canvas, input.instanceId]);
        return result;
      },
    } },
  };
  const legacy = {
    extensionId: "user:github-notifications", canvasId: "github-notifications",
    instanceId: "unread-notifications-startup", input: {},
  };
  assert.deepEqual((await open(current, legacy.instanceId)).assets, after.assets);
  livePanels.push(legacy);
  await import(pathToFileURL(entry).href + "?legacy-startup");
  assert.equal(opens.length, 0, "A restored legacy panel must prevent duplicate auto-open");
  await current.onClose({ instanceId: legacy.instanceId });
  livePanels.length = 0;
  for (const type of ["session.canvas.closed", "session.canvas.removed"]) {
    startupEvents.push({ type, data: legacy });
    await import(pathToFileURL(entry).href + "?legacy-" + type);
    assert.equal(opens.length, 0, "Legacy dismissal must survive provider reload");
    startupEvents.pop();
  }
  await import(pathToFileURL(entry).href + "?startup");
  assert.deepEqual(opens, [{
    extensionId: "user:github-notifications", canvasId: "github-notifications",
    instanceId: "github-notifications-startup", input: {},
  }]);
  const startup = globalThis.testCanvases.at(-1);
  const startupSettings = await startup.actions.find(action => action.name === "get_settings")
    .handler({ instanceId: "github-notifications-startup" });
  assert.equal(startupSettings.startupStatus, "opened");
  assert.equal(startupSettings.desktopNotifications, false);
  await import(pathToFileURL(entry).href + "?startup-reload");
  assert.equal(opens.length, 1, "Reloading must leave an existing panel alone");
  await startup.onClose({ instanceId: "github-notifications-startup" });
  livePanels.length = 0;
  startupEvents.push({ type: "session.canvas.removed", data: opens[0] });
  await import(pathToFileURL(entry).href + "?startup-dismissed");
  assert.equal(opens.length, 1, "Explicit dismissal must survive provider reload");
  globalThis.testSession = {
    ...globalThis.testSession,
    workspacePath: join(root, "another-auto-open-session"),
    getEvents: async () => [{ type: "session.resume" }],
  };
  await import(pathToFileURL(entry).href + "?another-session");
  assert.equal(opens.length, 2, "Dismissal must not suppress a different session");
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
    const source = await readFile(new URL(`../src/renderer/${file}`, import.meta.url));
    assert.ok(built.length < source.length, `${file} must be minified`);
    if (file === "app.mjs") {
      const icons = await readFile(new URL("../src/renderer/octicons.mjs", import.meta.url), "utf8");
      const notice = icons.replaceAll("\r\n", "\n").match(/\/\*![\s\S]*?\*\//)?.[0];
      assert.ok(notice && built.includes(notice), "The packaged renderer must retain the Octicons MIT license.");
    }
  }
});

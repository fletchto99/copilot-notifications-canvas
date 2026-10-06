import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const marker = ".copilot-notifications-install.json";
export const runtimeMarker = ".copilot-notifications-runtime.json";
export const sourceFiles = ["extension.mjs", "github.mjs", "inbox.mjs", "batch.mjs", "model.mjs", "server.mjs", "app.mjs",
  "settings.mjs", "startup.mjs", "index.html", "styles.css", "desktop.mjs", "notifier.mjs", "lock.mjs", "updates.mjs", "version.json"];
export const digest = content => createHash("sha256").update(content).digest("hex");

export async function home(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "notifications-install-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

export function intercept(t, name, handler) {
  const original = fs[name];
  fs[name] = (...args) => handler(original, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    fs[name] = original;
    syncBuiltinESMExports();
  });
}

export async function runtimePath(target) {
  const entry = await fs.readFile(join(target, "extension.mjs"), "utf8");
  const id = /^await import\("\.\/runtimes\/([a-f0-9]{64})\/extension\.mjs"\);\n$/.exec(entry)?.[1];
  return id ? join(target, "runtimes", id) : target;
}

export async function sourceContents() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    file, await fs.readFile(new URL(`../.github/extensions/github-notifications/${file}`, import.meta.url), "utf8"),
  ])));
}

export const legacyAssets = {
  "index.html": '<!doctype html><button id="sound">Legacy sound</button><script type="module" src="/app.mjs"></script>\n',
  "app.mjs": 'import { NotificationSound } from "./sound.mjs";\nexport const sound = new NotificationSound();\n',
  "styles.css": "/* legacy canvas styles */\n",
  "sound.mjs": "export class NotificationSound {}\n",
};

// Reproduce the old server's per-instance, relative-path asset cache.
const legacyServer = `
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
export async function startServer() {
  const assets = new Map(await Promise.all(
    [["/", "index.html"], ["/app.mjs", "app.mjs"], ["/styles.css", "styles.css"], ["/sound.mjs", "sound.mjs"]]
      .map(async ([path, file]) => [path, await readFile(new URL(file, import.meta.url))])));
  const server = createServer((request, response) => {
    response.writeHead(assets.has(request.url) ? 200 : 404);
    response.end(assets.get(request.url));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + server.address().port + "/",
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
`;

export async function legacyInstallation(root, { omit = [] } = {}) {
  const target = join(root, "extensions", "github-notifications");
  await fs.mkdir(target, { recursive: true });
  const contents = { ...await sourceContents(), ...legacyAssets,
    "server.mjs": legacyServer, "settings.mjs": "export class Preferences {}\n",
    "extension.mjs": 'export { startServer } from "./server.mjs";\n',
  };
  for (const file of ["desktop.mjs", "notifier.mjs", "lock.mjs", ...omit]) delete contents[file];
  const hashes = {};
  for (const [file, content] of Object.entries(contents)) {
    await fs.writeFile(join(target, file), content);
    hashes[file] = digest(content);
  }
  await fs.writeFile(join(target, marker), JSON.stringify({ name: "github-notifications", version: 1, hashes }));
  return { target, contents };
}

export async function olderRuntime(root) {
  const target = join(root, "extensions", "github-notifications");
  const contents = await sourceContents();
  contents["app.mjs"] += "\n// Previous synthetic runtime.\n";
  contents["styles.css"] += "\n/* Previous synthetic runtime. */\n";
  contents["index.html"] = contents["index.html"].replace("<title>Unread Notifications</title>", "<title>Previous runtime</title>");
  const hashes = Object.fromEntries(Object.entries(contents).map(([file, content]) => [file, digest(content)]));
  const id = digest(JSON.stringify(Object.keys(hashes).sort().map(file => [file, hashes[file]])));
  const directory = join(target, "runtimes", id);
  await fs.mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(contents)) await fs.writeFile(join(directory, file), content);
  await fs.writeFile(join(directory, runtimeMarker), JSON.stringify({ name: "github-notifications", version: 1, hashes }));
  const entry = `await import("./runtimes/${id}/extension.mjs");\n`;
  await fs.writeFile(join(target, "extension.mjs"), entry);
  await fs.writeFile(join(target, marker), JSON.stringify({
    name: "github-notifications", version: 2, runtime: id, hashes: { "extension.mjs": digest(entry) },
  }));
  return { target, directory, contents };
}

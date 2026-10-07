import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../scripts/install.mjs";
import { encodeBundle, hash, name } from "../scripts/package.mjs";

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

export async function fixture(t, { root, version = "1.0.0", code } = {}) {
  root ??= await home(t);
  const directory = await home(t);
  const contents = {
    "extension.mjs": encodeBundle(code ?? `export const version = ${JSON.stringify(version)};\n`, version),
    "install.mjs": "// Synthetic package installer; integration tests exercise the real installer.\n",
  };
  for (const [file, content] of Object.entries(contents)) await fs.writeFile(join(directory, file), content);
  const manifest = { name, format: 1, version,
    hashes: Object.fromEntries(Object.entries(contents).map(([file, content]) => [file, hash(content)])) };
  await fs.writeFile(join(directory, "release.json"), JSON.stringify(manifest));
  return { root, directory, version, content: contents["extension.mjs"], manifest,
    target: join(root, "extensions", name),
    install: () => install({ home: root, directory, tag: `v${version}` }) };
}

import { readFile } from "node:fs/promises";

const assets = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.mjs", "app.mjs", "text/javascript; charset=utf-8"],
  ["/model.mjs", "model.mjs", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
];

export const assetPaths = new Set(assets.map(([path]) => path));

export async function loadAssets({ read = readFile, signal } = {}) {
  return new Map(await Promise.all(assets.map(async ([path, file, type]) =>
    [path, { body: await read(new URL(file, import.meta.url), { signal }), type }])));
}

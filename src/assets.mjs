import { readFile } from "node:fs/promises";

export async function loadAssets() {
  return new Map(await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.mjs", "app.mjs", "text/javascript; charset=utf-8"],
    ["/model.mjs", "model.mjs", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ].map(async ([path, file, type]) =>
    [path, { body: await readFile(new URL(file, import.meta.url)), type }])));
}

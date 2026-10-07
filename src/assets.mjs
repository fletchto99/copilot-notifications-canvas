import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import metadata from "../version.json" with { type: "json" };

const assets = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.mjs", "app.mjs", "text/javascript; charset=utf-8"],
  ["/model.mjs", "model.mjs", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
];

export const assetPaths = new Set(assets.map(([path]) => path));

function runGit(args, options) {
  return new Promise((resolve, reject) => {
    execFile("git", args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function loadDevelopmentInfo({ run = runGit, log = () => {}, signal } = {}) {
  let branch;
  try {
    const stdout = await run(["symbolic-ref", "--quiet", "HEAD"], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 2000, maxBuffer: 4096, signal,
    });
    const ref = stdout.trim();
    if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") throw new Error("Invalid branch reference.");
    branch = ref.slice("refs/heads/".length);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 1) {
      branch = "detached HEAD";
    } else {
      branch = "branch unavailable";
      log("Could not read the development branch for the notifications footer.", { level: "warning" });
    }
  }
  return { version: metadata.version, branch };
}

export async function loadAssets({ read = readFile, signal } = {}) {
  return new Map(await Promise.all(assets.map(async ([path, file, type]) =>
    [path, { body: await read(new URL(file, import.meta.url), { signal }), type }])));
}

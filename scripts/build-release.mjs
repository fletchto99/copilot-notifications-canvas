import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, transform } from "esbuild";
import { validateReleaseTag } from "./check-release.mjs";
import { archiveName, encodeBundle, hash, loadPackage, name } from "./package.mjs";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const execute = promisify(execFile);
const nodeOptions = { bundle: true, platform: "node", format: "esm", target: "node22", minify: true, write: false };

export function embeddedAssetsPlugin(assets) {
  return {
    name: "embedded-assets",
    setup(builder) {
      builder.onLoad({ filter: /[/\\]assets\.mjs$/ }, args => args.path === join(source, "assets.mjs") ? {
        contents: `import assets from "notifications:assets";
export const assetPaths = new Set(assets.map(([path]) => path));
export async function loadAssets() { return new Map(assets); }`,
        loader: "js",
      } : undefined);
      builder.onResolve({ filter: /^notifications:assets$/ }, () => ({
        path: "assets", namespace: "notification-assets",
      }));
      builder.onLoad({ filter: /^assets$/, namespace: "notification-assets" }, () => ({
        contents: JSON.stringify(assets), loader: "json",
      }));
    },
  };
}

export async function buildRelease({ tag, directory = resolve("dist") }) {
  validateReleaseTag(tag);
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(directory, ".package-"));
  try {
    const browser = await build({
      entryPoints: [join(source, "app.mjs")], bundle: true, platform: "browser",
      format: "esm", target: "es2022", minify: true, write: false,
    });
    const css = await transform(await readFile(join(source, "styles.css"), "utf8"), { loader: "css", minify: true });
    const assets = [
      ["/", { body: await readFile(join(source, "index.html"), "utf8"), type: "text/html; charset=utf-8" }],
      ["/app.mjs", { body: browser.outputFiles[0].text, type: "text/javascript; charset=utf-8" }],
      ["/styles.css", { body: css.code, type: "text/css; charset=utf-8" }],
    ];
    const runtime = await build({
      ...nodeOptions, entryPoints: [join(source, "extension.mjs")],
      external: ["@github/copilot-sdk/extension"], metafile: true,
      plugins: [embeddedAssetsPlugin(assets)],
    });
    const imports = Object.values(runtime.metafile.outputs).flatMap(output => output.imports);
    if (imports.some(item => !item.path.startsWith("node:") && item.path !== "@github/copilot-sdk/extension")) {
      throw new Error("The release runtime has an unexpected external dependency.");
    }
    const installer = await build({
      ...nodeOptions, entryPoints: [fileURLToPath(new URL("./install.mjs", import.meta.url))],
    });
    const contents = {
      "extension.mjs": encodeBundle(runtime.outputFiles[0].text, tag.slice(1)),
      "install.mjs": installer.outputFiles[0].text,
    };
    for (const [file, content] of Object.entries(contents)) await writeFile(join(stage, file), content);
    await writeFile(join(stage, "release.json"), `${JSON.stringify({
      name, format: 1, version: tag.slice(1),
      hashes: Object.fromEntries(Object.entries(contents).map(([file, content]) => [file, hash(content)])),
    }, null, 2)}\n`);
    await loadPackage(stage, tag);
    const archive = archiveName(tag);
    await execute("tar", ["-czf", join(stage, archive), "-C", stage, "extension.mjs", "install.mjs", "release.json"]);
    await writeFile(join(stage, "SHA256SUMS"), `${hash(await readFile(join(stage, archive)))}  ${archive}\n`);
    await rename(join(stage, archive), join(directory, archive));
    await rename(join(stage, "SHA256SUMS"), join(directory, "SHA256SUMS"));
    return join(directory, archive);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`Built ${await buildRelease({ tag: process.argv[2] })}\n`);
  } catch (error) {
    process.stderr.write(`Build stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}

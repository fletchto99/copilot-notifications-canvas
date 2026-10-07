import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import metadata from "../version.json" with { type: "json" };
import { versionParts } from "../src/version.mjs";

const CURRENT_VERSION = metadata.version;

export function validateReleaseTag(tag, version = CURRENT_VERSION) {
  if (!versionParts(version) || tag !== `v${version}`) {
    throw new Error("Release tag must equal v plus the stable version in the repository-root version.json.");
  }
  return tag;
}

export function normalizeReleaseTag(value, version = CURRENT_VERSION) {
  return validateReleaseTag(typeof value === "string" && !value.startsWith("v") ? `v${value}` : value, version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tag = normalizeReleaseTag(process.argv[2]);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
    process.stdout.write(`Validated ${tag}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

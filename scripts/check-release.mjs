import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CURRENT_VERSION, versionParts } from "../.github/extensions/github-notifications/updates.mjs";

export function validateReleaseTag(tag, version = CURRENT_VERSION) {
  if (!versionParts(version) || tag !== `v${version}`) {
    throw new Error("Release tag must equal v plus the stable version in .github/extensions/github-notifications/version.json.");
  }
  return tag;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`Validated ${validateReleaseTag(process.argv[2])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

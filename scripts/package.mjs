import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { versionParts } from "../src/version.mjs";

export const name = "github-notifications";
const prefix = "// copilot-notifications-bundle: ";
export const hash = content => createHash("sha256").update(content).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = version => ({ name, format: 1, version });
const bundleHash = (version, code) => hash(`${JSON.stringify(identity(version))}\n${code}`);

export function archiveName(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !versionParts(tag.slice(1))) {
    throw new Error("Expected a stable vMAJOR.MINOR.PATCH release tag.");
  }
  return `${name}-${tag}.tar.gz`;
}

export function encodeBundle(code, version) {
  if (!versionParts(version) || typeof code !== "string" || !code.trim()) throw new Error("Invalid bundle input.");
  return `${prefix}${JSON.stringify({ ...identity(version), sha256: bundleHash(version, code) })}\n${code}`;
}

export function inspectBundle(content) {
  const text = content.toString("utf8");
  const end = text.indexOf("\n");
  if (!text.startsWith(prefix) || end < 0 || end > 1024) {
    throw new Error("Unrecognized or legacy runtime. Follow the README's one-time migration; do not overwrite it.");
  }
  let metadata;
  try {
    metadata = JSON.parse(text.slice(prefix.length, end));
  } catch {
    throw new Error("Invalid bundle ownership metadata. Preserve any local modifications.");
  }
  const code = text.slice(end + 1);
  if (metadata?.name !== name || metadata.format !== 1 || !versionParts(metadata.version) ||
      !validHash(metadata.sha256) || !code.trim() || bundleHash(metadata.version, code) !== metadata.sha256 ||
      text.slice(0, end) !== `${prefix}${JSON.stringify({ ...identity(metadata.version), sha256: metadata.sha256 })}`) {
    throw new Error("Bundle metadata or code was modified. Preserve your changes; refusing to overwrite it.");
  }
  return { version: metadata.version, digest: hash(content) };
}

export async function readRegular(path) {
  if (!(await lstat(path)).isFile()) throw new Error("Refusing a symlink or non-regular package/runtime file.");
  return readFile(path);
}

export async function loadPackage(directory, tag) {
  archiveName(tag);
  const expected = ["extension.mjs", "install.mjs", "release.json"];
  const entries = await readdir(directory);
  if (entries.length !== expected.length || entries.some(file => !expected.includes(file))) {
    throw new Error("Run the installer from a freshly extracted, verified release package, not a source checkout.");
  }
  const manifest = JSON.parse(await readRegular(join(directory, "release.json")));
  if (manifest?.name !== name || manifest.format !== 1 || manifest.version !== tag.slice(1) ||
      !manifest.hashes || Object.keys(manifest.hashes).length !== 2 ||
      !["extension.mjs", "install.mjs"].every(file => validHash(manifest.hashes[file]))) {
    throw new Error("Release manifest does not match the requested tag or package format.");
  }
  const content = await readRegular(join(directory, "extension.mjs"));
  for (const file of ["extension.mjs", "install.mjs"]) {
    if (hash(file === "extension.mjs" ? content : await readRegular(join(directory, file))) !== manifest.hashes[file]) {
      throw new Error(`Release checksum mismatch for ${file}. Download and verify the release again.`);
    }
  }
  const bundle = inspectBundle(content);
  if (bundle.version !== manifest.version) throw new Error("Bundle version does not match the release manifest.");
  return { ...bundle, content };
}

export async function verifyArchive(directory, tag) {
  const archive = archiveName(tag);
  const content = await readRegular(join(directory, archive));
  const checksum = await readRegular(join(directory, "SHA256SUMS"));
  if (checksum.toString("utf8") !== `${hash(content)}  ${archive}\n`) {
    throw new Error("Release archive checksum mismatch.");
  }
  return [join(directory, archive), join(directory, "SHA256SUMS")];
}

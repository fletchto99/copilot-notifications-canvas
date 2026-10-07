import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateReleaseTag } from "./check-release.mjs";
import { verifyArchive } from "./package.mjs";

const execute = promisify(execFile);
const runGh = async args => (await execute("gh", args, {
  timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
})).stdout;

export async function publishRelease({ tag, sha, event, ref, directory = resolve("dist"), run = runGh }) {
  validateReleaseTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full tested commit SHA is required.");
  if (event !== "push" || ref !== `refs/tags/${tag}`) {
    throw new Error("Publish only from a matching release-tag push.");
  }
  const assets = await verifyArchive(directory, tag);
  // The commits endpoint also resolves annotated tags to their commit.
  const commit = JSON.parse(await run(["api", `repos/{owner}/{repo}/commits/${tag}`]));
  if (commit?.sha !== sha) {
    throw new Error("The release tag does not point to the tested commit. Refusing to move or publish it.");
  }
  const listing = await run(["api", "--paginate", "repos/{owner}/{repo}/releases?per_page=100",
    "--jq", "map({tag_name, draft}) | tojson"]);
  let pages;
  try {
    pages = listing.trim().split("\n").map(line => JSON.parse(line));
  } catch {
    throw new Error("GitHub returned unreadable release metadata. Refusing to publish.");
  }
  if (pages.some(page => !Array.isArray(page) ||
      page.some(release => typeof release?.tag_name !== "string" || typeof release.draft !== "boolean"))) {
    throw new Error("GitHub returned invalid release metadata. Refusing to publish.");
  }
  if (pages.some(page => page.some(release => release.tag_name === tag))) {
    throw new Error(`A release or draft already exists for ${tag}. Inspect it before retrying; existing releases are never modified.`);
  }
  // With assets, gh creates a draft, uploads, then publishes that exact release by ID.
  return (await run(["release", "create", tag, ...assets,
    "--verify-tag", "--generate-notes", "--title", tag, "--latest"])).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const url = await publishRelease({
      tag: process.argv[2],
      sha: process.env.GITHUB_SHA,
      event: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
    });
    process.stdout.write(`${url}\n`);
  } catch (error) {
    process.stderr.write(`Release stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}

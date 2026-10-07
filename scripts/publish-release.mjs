import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateReleaseTag } from "./check-release.mjs";
import { verifyArchive } from "./package.mjs";

const execute = promisify(execFile);
const repository = "fletchto99/copilot-notifications-canvas";
const runGh = async args => (await execute("gh", args, {
  timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
})).stdout;

export async function publishRelease({
  tag, sha, event, ref, directory = resolve("dist"), run = runGh,
  sleep = wait, log = message => process.stderr.write(`${message}\n`),
}) {
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
  const comparison = JSON.parse(await run(["api", `repos/{owner}/{repo}/compare/${sha}...main`]));
  if (!["ahead", "identical"].includes(comparison?.status) || comparison?.merge_base_commit?.sha !== sha) {
    throw new Error("The tested release commit is not on main. Merge through the protected branch before tagging.");
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
  await run(["release", "verify", "--help"]);
  await run(["release", "verify-asset", "--help"]);
  // Exact certificate identity avoids older gh versions' workflow-prefix matching.
  await run(["attestation", "verify", assets[0],
    "--repo", repository, "--hostname", "github.com",
    "--cert-identity", `https://github.com/${repository}/.github/workflows/release.yml@${ref}`,
    "--source-ref", ref, "--source-digest", sha, "--signer-digest", sha,
    "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1"]);
  // With assets, gh creates a draft, uploads, then publishes that exact release by ID.
  const url = (await run(["release", "create", tag, ...assets,
    "--verify-tag", "--generate-notes", "--title", tag, "--latest"])).trim();
  const verificationDelays = [5_000, 5_000, 10_000, 20_000];
  for (const [attempt, delay] of verificationDelays.entries()) {
    log(`Waiting ${delay / 1000}s before verifying published release ${tag} (attempt ${attempt + 1}/${verificationDelays.length}).`);
    await sleep(delay);
    try {
      await run(["release", "verify", tag]);
      for (const asset of assets) await run(["release", "verify-asset", tag, asset]);
      return url;
    } catch (error) {
      const missingTag = error?.stderr?.trim().match(/^no attestations(?: found)? for tag (.+) \(sha1:[a-f0-9]{40}\)$/)?.[1];
      if (error?.code !== 1 || missingTag !== tag || attempt === verificationDelays.length - 1) throw error;
    }
  }
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

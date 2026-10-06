import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateReleaseTag } from "./check-release.mjs";

const execute = promisify(execFile);
const runGh = async args => (await execute("gh", args, {
  timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
})).stdout;

export async function publishRelease({ tag, sha, event, ref, run = runGh }) {
  validateReleaseTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full tested commit SHA is required.");
  const manual = event === "workflow_dispatch";
  if (manual ? ref !== "refs/heads/main" : event !== "push" || ref !== `refs/tags/${tag}`) {
    throw new Error("Publish only from a manual run on main or a matching release-tag push.");
  }

  const refs = JSON.parse(await run(["api", `repos/{owner}/{repo}/git/matching-refs/tags/${tag}`]));
  if (!Array.isArray(refs)) throw new Error("GitHub returned invalid tag metadata.");
  if (!refs.some(entry => entry.ref === `refs/tags/${tag}`)) {
    if (!manual) throw new Error("The pushed release tag no longer exists. Refusing to recreate it.");
    await run(["api", "--method", "POST", "repos/{owner}/{repo}/git/refs",
      "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`]);
  }
  // The commits endpoint also resolves annotated tags to their commit.
  const commit = JSON.parse(await run(["api", `repos/{owner}/{repo}/commits/${tag}`]));
  if (commit?.sha !== sha) {
    throw new Error("The release tag does not point to the tested commit. Refusing to move or publish it.");
  }
  return (await run(["release", "create", tag, "--verify-tag", "--generate-notes", "--title", tag])).trim();
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

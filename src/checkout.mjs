import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { InboxError } from "./model.mjs";

function runGit(args, options) {
  return new Promise((resolve, reject) => {
    execFile("git", args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function prepareCommit(repository, target, { signal, beforeFetch, run = runGit } = {}) {
  const closed = () => {
    if (signal?.aborted) throw new InboxError("closed", "The canvas was closed.", 410);
  };
  closed();
  if (!target || typeof target.sha !== "string" || !/^[a-f0-9]{40}$/.test(target.sha) ||
      typeof target.repository !== "string" ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(target.repository) ||
      [".", ".."].includes(target.repository.split("/")[1]) ||
      !["continue", "review", "summarize", "ci", "commit"].includes(target.action) ||
      !["ci", "commit"].includes(target.action) && !/^[1-9]\d*$/.test(target.number)) {
    throw new InboxError("copilot_checkout", "The selected GitHub commit could not be verified.", 400);
  }
  if (!repository || repository.remote_only || typeof repository.main_repo_path !== "string" ||
      !isAbsolute(repository.main_repo_path) ||
      typeof repository.github_repo !== "string" || repository.github_repo.toLowerCase() !== target.repository.toLowerCase()) {
    throw new InboxError("copilot_checkout",
      "The host did not expose an accessible local checkout for this repository. Configure a checkout on this execution host before starting a PR, CI, or commit handoff.", 409);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || ["GH_DEBUG", "DEBUG"].includes(key)) delete env[key];
  }
  Object.assign(env, { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", NO_COLOR: "1" });
  let fetching = false;
  try {
    const cwd = await realpath(repository.main_repo_path);
    const git = async (args, timeout = 10_000) => {
      closed();
      try {
        const stdout = await run(args, { cwd, env, signal, timeout, maxBuffer: 64 * 1024, encoding: "utf8" });
        closed();
        return stdout;
      } catch (error) {
        closed();
        if (error.code === "ENOENT") {
          throw new InboxError("git_missing", "Git is unavailable on the extension host. Install Git and reopen the repository before retrying.", 503);
        }
        if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw new InboxError("copilot_checkout_timeout", "Preparing the selected commit timed out or exceeded its response limit. Check repository access and retry.", 504);
        }
        throw error;
      }
    };
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(root) !== cwd) {
      throw new InboxError("copilot_checkout", "The configured checkout is not the repository root. Reopen the repository in Copilot before retrying.", 409);
    }
    const hasCommit = async () => {
      try {
        const resolved = (await git(["rev-parse", "--verify", "--quiet", `${target.sha}^{commit}`])).trim();
        if (resolved !== target.sha) {
          throw new InboxError("copilot_checkout", "The selected revision did not resolve to the verified commit.", 409);
        }
        return true;
      } catch (error) {
        if (error.code === 1) return false;
        throw error;
      }
    };
    if (await hasCommit()) return;
    await beforeFetch?.();
    fetching = true;
    const ref = ["ci", "commit"].includes(target.action) ? target.sha : `refs/pull/${target.number}/head`;
    await git([
      "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
      "fetch", "--quiet", "--no-tags", "--no-prune", "--no-prune-tags", "--refmap=",
      "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-gc",
      `https://github.com/${target.repository}.git`, ref,
    ], 120_000);
    if (!await hasCommit()) {
      throw new InboxError("copilot_commit_missing",
        "The selected commit is still unavailable after fetching its ref. Refresh the notification and retry; no session was created.", 409);
    }
  } catch (error) {
    closed();
    if (error instanceof InboxError) throw error;
    throw new InboxError("copilot_checkout", fetching
      ? "Could not fetch the selected commit. Check gh auth status, repository access, and network connectivity, then refresh the notification before retrying."
      : "Could not inspect the configured repository checkout on this extension host. Reopen the repository in Copilot before retrying.", 502);
  }
}

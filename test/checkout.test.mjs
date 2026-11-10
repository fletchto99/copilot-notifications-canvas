import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareCommit } from "../src/provider/checkout.mjs";
import { InboxError } from "../src/shared/model.mjs";

const execute = promisify(execFile);
const sha = "a".repeat(40);
const target = { action: "review", repository: "example/widgets", number: "42", sha };
const missing = () => Object.assign(new Error("Synthetic missing revision"), { code: 1 });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "notification-checkout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root: await realpath(root), repository: { github_repo: target.repository, main_repo_path: root } };
}

test("known commits are checked without fetching and process errors stay sanitized", async t => {
  const { root, repository } = await fixture(t);
  const calls = [];
  await prepareCommit(repository, target, { run: async (args, options) => {
    calls.push(args);
    assert.equal(options.cwd, root);
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.GH_PROMPT_DISABLED, "1");
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.GIT_TRACE, undefined);
    return args.includes("--show-toplevel") ? root : sha;
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls.some(args => args.includes("fetch")), false);
  for (const [error, code] of [
    [Object.assign(new Error("SECRET"), { code: "ENOENT" }), "git_missing"],
    [Object.assign(new Error("SECRET"), { killed: true }), "copilot_checkout_timeout"],
    [Object.assign(new Error("SECRET"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "copilot_checkout_timeout"],
    [new Error("SECRET"), "copilot_checkout"],
  ]) {
    await assert.rejects(prepareCommit(repository, target, { run: async () => { throw error; } }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
});

test("unavailable checkouts and invalid references never run Git", async t => {
  const { root, repository } = await fixture(t);
  const run = () => assert.fail("Invalid checkout input must not run Git");
  for (const change of [{ sha: "main" }, { repository: "../widgets" }, { repository: "example/.." },
    { action: "issue" }, { number: "-1" }]) {
    await assert.rejects(prepareCommit(repository, { ...target, ...change }, { run }), { code: "copilot_checkout" });
  }
  for (const change of [{ remote_only: true }, { main_repo_path: undefined },
    { main_repo_path: "relative" }, { github_repo: "other/widgets" }]) {
    await assert.rejects(prepareCommit({ ...repository, ...change }, target, { run }), { code: "copilot_checkout" });
  }
  await assert.rejects(prepareCommit({ ...repository, main_repo_path: join(root, "absent") }, target, { run }),
    { code: "copilot_checkout" });
  const nested = join(root, "nested");
  await mkdir(nested);
  await assert.rejects(prepareCommit({ ...repository, main_repo_path: nested }, target, { run: async () => root }),
    { code: "copilot_checkout" });
});

test("missing commits fetch only the selected ref and verify it again before success", async t => {
  const { root, repository } = await fixture(t);
  const calls = [];
  let fetched = false;
  let checked = false;
  await prepareCommit(repository, target, {
    beforeFetch: async () => { checked = true; },
    run: async (args, options) => {
      calls.push(args);
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("fetch")) {
        assert.equal(checked, true);
        assert.equal(options.timeout, 120_000);
        assert.deepEqual(args, [
          "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
          "fetch", "--quiet", "--no-tags", "--no-prune", "--no-prune-tags", "--refmap=",
          "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-gc",
          "https://github.com/example/widgets.git", "refs/pull/42/head",
        ]);
        fetched = true;
        return "";
      }
      if (!fetched) throw missing();
      return sha;
    },
  });
  assert.equal(calls.at(-1).at(-1), `${sha}^{commit}`);
  assert.equal(calls.filter(args => args.includes("fetch")).length, 1);
});

test("fetch failures, moved refs, and wrong resolved objects never fall back to another revision", async t => {
  const { root, repository } = await fixture(t);
  for (const outcome of ["fetch failure", "still missing", "wrong object"]) {
    const calls = [];
    let fetched = false;
    await assert.rejects(prepareCommit(repository, target, { run: async args => {
      calls.push(args);
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("fetch")) {
        fetched = true;
        if (outcome === "fetch failure") throw new Error("SECRET raw transport error");
        return "";
      }
      if (!fetched || outcome === "still missing") throw missing();
      return "b".repeat(40);
    } }), error => {
      assert.ok(error instanceof InboxError);
      assert.equal(error.code, outcome === "still missing" ? "copilot_commit_missing" : "copilot_checkout");
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
    assert.equal(calls.filter(args => args.includes("fetch")).length, 1);
    assert.equal(calls.some(args => args.includes("checkout") || args.includes("reset")), false);
  }
});

test("cancellation and revoked approval stop preparation before later operations", async t => {
  const { root, repository } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareCommit(repository, target, { signal: controller.signal, run: () => assert.fail() }),
    { code: "closed" });
  const calls = [];
  await assert.rejects(prepareCommit(repository, target, {
    beforeFetch: async () => { throw new InboxError("copilot_disabled", "Synthetic disabled integration"); },
    run: async args => {
      calls.push(args);
      if (args.includes("--show-toplevel")) return root;
      throw missing();
    },
  }), { code: "copilot_disabled" });
  assert.equal(calls.some(args => args.includes("fetch")), false);
  const active = new AbortController();
  await assert.rejects(prepareCommit(repository, target, { signal: active.signal, run: async args => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("fetch")) { active.abort(); return ""; }
    throw missing();
  } }), { code: "closed" });
});

test("real Git can create the exact worktree after preparation without changing the existing checkout", async t => {
  for (const action of ["review", "summarize", "ci", "commit"]) await t.test(action, async t => {
    const { root } = await fixture(t);
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const base = join(root, "base");
    const config = join(root, "empty-gitconfig");
    await writeFile(config, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_ALLOW_PROTOCOL: "file",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_TERMINAL_PROMPT: "0",
    });
    const git = async args => (await execute("git", args, { env, encoding: "utf8", timeout: 10_000 })).stdout.trim();
    await git(["init", "--quiet", "--bare", remote]);
    await git(["init", "--quiet", "--initial-branch=main", seed]);
    await writeFile(join(seed, "file.txt"), "base\n");
    await git(["-C", seed, "add", "file.txt"]);
    await git(["-C", seed, "commit", "--quiet", "-m", "Synthetic base"]);
    await git(["-C", seed, "push", "--quiet", remote, "HEAD:refs/heads/main"]);
    await git(["init", "--quiet", base]);
    await git(["-C", base, "fetch", "--quiet", remote, "refs/heads/main"]);
    await git(["-C", base, "checkout", "--quiet", "-b", "main", "FETCH_HEAD"]);
    await git(["-C", base, "remote", "add", "origin", pathToFileURL(remote).href]);
    await git(["-C", base, "config", "--add", "remote.origin.fetch", "+refs/pull/*:refs/remotes/origin/pr/*"]);
    await git(["-C", base, "config", "fetch.prune", "true"]);
    await git(["-C", base, "config", "fetch.pruneTags", "true"]);
    const initialHead = await git(["-C", base, "rev-parse", "HEAD"]);
    await git(["-C", base, "update-ref", "refs/remotes/origin/local-only", initialHead]);
    await git(["-C", base, "update-ref", "refs/tags/local-only", initialHead]);
    await writeFile(join(seed, "file.txt"), "selected commit\n");
    await git(["-C", seed, "commit", "--quiet", "-am", "Synthetic selected commit"]);
    const selected = await git(["-C", seed, "rev-parse", "HEAD"]);
    await git(["-C", seed, "push", "--quiet", remote, "HEAD:refs/pull/42/head"]);
    await assert.rejects(git(["-C", base, "rev-parse", "--verify", "--quiet", `${selected}^{commit}`]));
    await writeFile(join(base, "file.txt"), "uncommitted user work\n");
    await writeFile(join(base, ".git", "FETCH_HEAD"), "preserve fetch metadata\n");
    const storedConfig = await readFile(join(base, ".git", "config"), "utf8");
    const refs = await git(["-C", base, "for-each-ref", "--format=%(refname) %(objectname)"]);
    let fetches = 0;
    const prepare = () => prepareCommit({ github_repo: target.repository, main_repo_path: base },
      { ...target, action, sha: selected }, { run: async (args, options) => {
        const actual = [...args];
        if (args.includes("fetch")) {
          fetches++;
          assert.equal(args.at(-1), ["ci", "commit"].includes(action) ? selected : "refs/pull/42/head");
          const index = actual.indexOf("https://github.com/example/widgets.git");
          assert.ok(index >= 0);
          actual[index] = pathToFileURL(remote).href;
        }
        return (await execute("git", actual, { ...options, env: { ...options.env,
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_ALLOW_PROTOCOL: "file" } })).stdout;
      } });
    await prepare();
    await prepare();
    assert.equal(fetches, 1, "An already-present commit must not fetch again");
    assert.equal(await git(["-C", base, "rev-parse", "HEAD"]), initialHead);
    assert.equal(await git(["-C", base, "symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(await git(["-C", base, "for-each-ref", "--format=%(refname) %(objectname)"]), refs);
    assert.equal(await readFile(join(base, "file.txt"), "utf8"), "uncommitted user work\n");
    assert.equal(await readFile(join(base, ".git", "FETCH_HEAD"), "utf8"), "preserve fetch metadata\n");
    assert.equal(await readFile(join(base, ".git", "config"), "utf8"), storedConfig);
    const worktree = join(root, "worktree");
    await git(["-C", base, "worktree", "add", "--quiet", "--detach", worktree, selected]);
    assert.equal(await git(["-C", worktree, "rev-parse", "HEAD"]), selected);
    assert.equal(await readFile(join(worktree, "file.txt"), "utf8"), "selected commit\n");
  });
});

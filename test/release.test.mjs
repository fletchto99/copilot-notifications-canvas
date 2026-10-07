import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeReleaseTag } from "../scripts/check-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { CURRENT_VERSION } from "../src/updates.mjs";
import { archiveName, hash } from "../scripts/package.mjs";
import { home } from "./install-fixtures.mjs";

const tag = `v${CURRENT_VERSION}`;
const sha = "a".repeat(40);
const ref = `refs/tags/${tag}`;
const url = `https://github.com/example/repo/releases/tag/${tag}`;

test("release input accepts a bare version or one v prefix without weakening version validation", () => {
  for (const input of [CURRENT_VERSION, tag]) assert.equal(normalizeReleaseTag(input), tag);
  for (const input of [undefined, null, "", `v${tag}`, `${tag}-rc.1`, "999.0.0",
    ` ${tag}`, `${tag}\n`, `${CURRENT_VERSION}\ntag=unsafe`]) {
    assert.throws(() => normalizeReleaseTag(input), String(input));
  }
});

test("release validation writes only a validated canonical tag to GitHub Actions output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-release-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const script = fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url));
  const run = input => promisify(execFile)(process.execPath, [script, input], {
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  for (const input of [CURRENT_VERSION, tag]) {
    await writeFile(output, "existing=preserved\n");
    const { stdout } = await run(input);
    assert.equal(stdout, `Validated ${tag}\n`);
    assert.equal(await readFile(output, "utf8"), `existing=preserved\ntag=${tag}\n`);
  }
  await writeFile(output, "existing=preserved\n");
  await assert.rejects(run(`v${tag}`), { code: 1 });
  assert.equal(await readFile(output, "utf8"), "existing=preserved\n");
});

async function fixture(t, {
  remoteSha = sha, comparison = { status: "ahead", merge_base_commit: { sha } },
  pages = [[]], listResponse, fail,
} = {}) {
  const directory = await home(t);
  const archive = archiveName(tag);
  const content = "Synthetic archive; package integration tests validate the real archive.";
  await writeFile(join(directory, archive), content);
  await writeFile(join(directory, "SHA256SUMS"), `${hash(content)}  ${archive}\n`);
  const calls = [];
  const run = async args => {
    calls.push(args);
    let operation;
    let result;
    if (args[0] === "release" && args[1] === "create") {
      operation = "create";
      result = `${url}\n`;
    } else if (args[0] === "release" && ["verify", "verify-asset"].includes(args[1])) {
      operation = args.includes("--help") ? `help-${args[1]}` : args[1];
      result = "Verified\n";
    } else if (args[1].includes("/commits/")) {
      operation = "resolve";
      result = JSON.stringify({ sha: remoteSha });
    } else if (args[1].includes("/compare/")) {
      operation = "ancestry";
      result = JSON.stringify(comparison);
    } else if (args[0] === "api" && args.includes("repos/{owner}/{repo}/releases?per_page=100")) {
      operation = "list";
      result = listResponse ?? `${pages.map(page => JSON.stringify(page)).join("\n")}\n`;
    } else {
      throw new Error(`Unexpected gh invocation: ${JSON.stringify(args)}`);
    }
    if (fail === operation) throw new Error(`Synthetic ${operation} failure`);
    return result;
  };
  return {
    calls, directory,
    input: { tag, sha, event: "push", ref, directory, run },
  };
}

test("tagged releases use one upload-and-publish command without a tag-based edit", async t => {
  const item = await fixture(t);
  assert.equal(await publishRelease(item.input), url);
  assert.deepEqual(item.calls, [
    ["api", `repos/{owner}/{repo}/commits/${tag}`],
    ["api", `repos/{owner}/{repo}/compare/${sha}...main`],
    ["api", "--paginate", "repos/{owner}/{repo}/releases?per_page=100",
      "--jq", "map({tag_name, draft}) | tojson"],
    ["release", "verify", "--help"],
    ["release", "verify-asset", "--help"],
    ["release", "create", tag, join(item.directory, archiveName(tag)), join(item.directory, "SHA256SUMS"),
      "--verify-tag", "--generate-notes", "--title", tag, "--latest"],
    ["release", "verify", tag],
    ["release", "verify-asset", tag, join(item.directory, archiveName(tag))],
    ["release", "verify-asset", tag, join(item.directory, "SHA256SUMS")],
  ]);
});

test("version, commit and event validation reject invalid requests before contacting GitHub", async t => {
  for (const invalid of [
    { tag: "v999.0.0" }, { tag: `${tag}; command` }, { sha: "main" }, { sha: undefined },
    { ref: "refs/heads/feature" }, { event: "workflow_dispatch" }, { event: "release" },
    { event: "push", ref: "refs/heads/main" }, { event: "push", ref: `${ref}-rc.1` },
  ]) {
    const item = await fixture(t);
    await assert.rejects(publishRelease({ ...item.input, ...invalid }));
    assert.deepEqual(item.calls, [], JSON.stringify(invalid));
  }
});

test("a tag at another commit is never moved or released", async t => {
  const item = await fixture(t, { remoteSha: "b".repeat(40) });
  await assert.rejects(publishRelease(item.input), /does not point to the tested commit/);
  assert.deepEqual(item.calls, [["api", `repos/{owner}/{repo}/commits/${tag}`]]);
});

test("release commits must be ancestors of protected main, including its current tip", async t => {
  for (const comparison of [
    null, {}, { status: "ahead" }, { status: "behind", merge_base_commit: { sha } },
    { status: "diverged", merge_base_commit: { sha } },
    { status: "ahead", merge_base_commit: { sha: "b".repeat(40) } },
  ]) {
    const item = await fixture(t, { comparison });
    await assert.rejects(publishRelease(item.input), /not on main/);
    assert.equal(item.calls.length, 2);
    assert.ok(item.calls.every(args => args[0] === "api"));
  }
  const item = await fixture(t, { comparison: { status: "identical", merge_base_commit: { sha } } });
  assert.equal(await publishRelease(item.input), url);
});

test("missing or corrupted assets stop publication before contacting GitHub", async t => {
  const item = await fixture(t);
  await writeFile(join(item.directory, archiveName(tag)), "corrupted archive");
  await assert.rejects(publishRelease(item.input), /checksum mismatch/);
  assert.deepEqual(item.calls, []);
  await rm(join(item.directory, "SHA256SUMS"));
  await assert.rejects(publishRelease(item.input), /ENOENT/);
  assert.deepEqual(item.calls, []);
});

test("existing published releases and drafts on any page stop publication before writes", async t => {
  for (const draft of [false, true]) {
    for (const page of [0, 1]) {
      const existing = Object.freeze({ tag_name: tag, draft });
      const pages = [[{ tag_name: "v0.0.1", draft: false }], []];
      pages[page].push(existing);
      const item = await fixture(t, { pages });
      await assert.rejects(publishRelease(item.input), /A release or draft already exists/);
      assert.equal(item.calls.length, 3);
      assert.ok(item.calls.every(args => args[0] === "api" && !args.includes("--method")));
      assert.deepEqual(existing, { tag_name: tag, draft });
    }
  }
});

test("other versions and similar tag names do not block a new release", async t => {
  const item = await fixture(t, { pages: [
    [{ tag_name: `${tag}-rc.1`, draft: false }],
    [{ tag_name: `${tag}0`, draft: true }],
  ] });
  assert.equal(await publishRelease(item.input), url);
  assert.equal(item.calls.filter(args => args[1] === "create").length, 1);
});

test("a retry detects a draft left behind by an interrupted upload or publication", async t => {
  const pages = [[]];
  const item = await fixture(t, { pages, fail: "create" });
  await assert.rejects(publishRelease(item.input), /Synthetic create failure/);
  pages[0].push({ tag_name: tag, draft: true });
  item.calls.length = 0;
  await assert.rejects(publishRelease(item.input), /A release or draft already exists/);
  assert.equal(item.calls.length, 3);
  assert.ok(item.calls.every(args => args[0] === "api"));
});

test("invalid release-list responses fail closed before creation", async t => {
  for (const page of [null, {}, [null], ["unexpected"],
    [{ tag_name: tag }], [{ tag_name: tag, draft: "false" }], [{ draft: false }]]) {
    const item = await fixture(t, { pages: [page] });
    await assert.rejects(publishRelease(item.input), /invalid release metadata/);
    assert.equal(item.calls.length, 3);
    assert.ok(item.calls.every(args => args[0] === "api"));
  }
  for (const listResponse of ["", "{", "[]\n{"]) {
    const item = await fixture(t, { listResponse });
    await assert.rejects(publishRelease(item.input), /unreadable release metadata/);
    assert.equal(item.calls.length, 3);
    assert.ok(item.calls.every(args => args[0] === "api"));
  }
});

test("GitHub errors stop publication without fallback tag writes or extra release commands", async t => {
  for (const [fail, count] of [
    ["resolve", 1], ["ancestry", 2], ["list", 3], ["help-verify", 4],
    ["help-verify-asset", 5], ["create", 6], ["verify", 7], ["verify-asset", 8],
  ]) {
    const item = await fixture(t, { fail });
    await assert.rejects(publishRelease(item.input), new RegExp(`Synthetic ${fail} failure`));
    assert.equal(item.calls.length, count);
    assert.equal(item.calls.some(args => args.includes("--clobber") || args.includes("DELETE") || args.includes("POST")), false);
    assert.equal(item.calls.some(args => args[0] === "release" && !["create", "verify", "verify-asset"].includes(args[1])), false);
    assert.ok(item.calls.filter(args => args[1] === "create").length <= 1);
  }
});

test("only the tag workflow builds releases, and packaged checks precede publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const tests = await readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n {2}push:\n {4}tags: \["v\*"\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch|branches:/);
  assert.doesNotMatch(tests, /build-release|publish-release|npm run build/);
  assert.match(workflow, /checks:\n {4}needs: validate\n {4}uses: \.\/\.github\/workflows\/tests\.yml/);
  assert.match(workflow, /build:\n {4}needs: \[validate, checks\]/);
  assert.match(workflow, /publish:\n {4}needs: \[validate, build\]/);
  const buildJob = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  publish:"));
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
  assert.match(buildJob, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(buildJob, /contents: write|GH_TOKEN|id-token: write/);
  assert.match(publishJob, /permissions:\n {6}contents: write/);
  assert.doesNotMatch(publishJob, /npm (ci|install)|build-release\.mjs|package\.integration|node install\.mjs/);
  assert.match(publishJob, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);
  assert.match(publishJob, /digest-mismatch: error/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.ok(workflow.indexOf("git merge-base --is-ancestor") < workflow.indexOf("node scripts/check-release.mjs"));
  const commands = ["scripts/check-release.mjs", "npm ci",
    "scripts/build-release.mjs", "node --test test/package.integration.mjs", "scripts/publish-release.mjs"];
  const positions = commands.map(command => workflow.indexOf(command));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
});

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

async function fixture(t, { remoteSha = sha, fail } = {}) {
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
      operation = "upload";
      result = `${url}\n`;
    } else if (args[0] === "release" && args[1] === "edit") {
      operation = "publish";
      result = "";
    } else if (args[1].includes("/commits/")) {
      operation = "resolve";
      result = JSON.stringify({ sha: remoteSha });
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

test("tagged releases upload verified assets to a draft before publishing it as latest", async t => {
  const item = await fixture(t);
  assert.equal(await publishRelease(item.input), url);
  assert.deepEqual(item.calls, [
    ["api", `repos/{owner}/{repo}/commits/${tag}`],
    ["release", "create", tag, join(item.directory, archiveName(tag)), join(item.directory, "SHA256SUMS"),
      "--draft", "--verify-tag", "--generate-notes", "--title", tag],
    ["release", "edit", tag, "--draft=false", "--latest"],
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

test("missing or corrupted assets stop publication before contacting GitHub", async t => {
  const item = await fixture(t);
  await writeFile(join(item.directory, archiveName(tag)), "corrupted archive");
  await assert.rejects(publishRelease(item.input), /checksum mismatch/);
  assert.deepEqual(item.calls, []);
  await rm(join(item.directory, "SHA256SUMS"));
  await assert.rejects(publishRelease(item.input), /ENOENT/);
  assert.deepEqual(item.calls, []);
});

test("GitHub errors and existing drafts stop publication without tag writes or asset overwrites", async t => {
  for (const [fail, count] of [["resolve", 1], ["upload", 2], ["publish", 3]]) {
    const item = await fixture(t, { fail });
    await assert.rejects(publishRelease(item.input), new RegExp(`Synthetic ${fail} failure`));
    assert.equal(item.calls.length, count);
    assert.equal(item.calls.some(args => args.includes("--clobber") || args.includes("DELETE") || args.includes("POST")), false);
  }
});

test("only the tag workflow builds releases, and packaged checks precede publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const tests = await readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n {2}push:\n {4}tags: \["v\*"\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch|branches:/);
  assert.doesNotMatch(tests, /build-release|publish-release|npm run build/);
  assert.match(workflow, /checks:\n {4}needs: validate\n {4}uses: \.\/\.github\/workflows\/tests\.yml/);
  assert.match(workflow, /release:\n {4}needs: \[validate, checks\]/);
  const commands = ["scripts/check-release.mjs", "npm ci",
    "scripts/build-release.mjs", "node --test test/package.integration.mjs", "scripts/publish-release.mjs"];
  const positions = commands.map(command => workflow.indexOf(command));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
});

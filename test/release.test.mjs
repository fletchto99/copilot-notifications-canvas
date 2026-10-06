import test from "node:test";
import assert from "node:assert/strict";
import { publishRelease } from "../scripts/publish-release.mjs";
import { CURRENT_VERSION } from "../.github/extensions/github-notifications/updates.mjs";

const tag = `v${CURRENT_VERSION}`;
const sha = "a".repeat(40);
const ref = `refs/tags/${tag}`;
const url = `https://github.com/example/repo/releases/tag/${tag}`;

function fixture({ refs = [], remoteSha = sha, fail, event = "workflow_dispatch" } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    let operation;
    let result;
    if (args[0] === "release") {
      operation = "publish";
      result = `${url}\n`;
    } else if (args[1].includes("/git/matching-refs/")) {
      operation = "read";
      result = JSON.stringify(refs);
    } else if (args.includes("--method")) {
      operation = "create";
      result = JSON.stringify({ ref, object: { sha } });
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
    calls,
    input: { tag, sha, event, ref: event === "workflow_dispatch" ? "refs/heads/main" : ref, run },
  };
}

test("manual releases create a tag at the tested SHA and publish generated notes", async () => {
  const item = fixture();
  assert.equal(await publishRelease(item.input), url);
  assert.deepEqual(item.calls, [
    ["api", `repos/{owner}/{repo}/git/matching-refs/tags/${tag}`],
    ["api", "--method", "POST", "repos/{owner}/{repo}/git/refs", "-f", `ref=${ref}`, "-f", `sha=${sha}`],
    ["api", `repos/{owner}/{repo}/commits/${tag}`],
    ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", tag],
  ]);
});

test("version, commit and event validation reject invalid requests before contacting GitHub", async () => {
  for (const invalid of [
    { tag: "v999.0.0" }, { tag: `${tag}; command` }, { sha: "main" }, { sha: undefined },
    { ref: "refs/heads/feature" }, { ref }, { event: "release" },
    { event: "push", ref: "refs/heads/main" }, { event: "push", ref: `${ref}-rc.1` },
  ]) {
    const item = fixture();
    await assert.rejects(publishRelease({ ...item.input, ...invalid }));
    assert.deepEqual(item.calls, [], JSON.stringify(invalid));
  }
});

test("a manual rerun can reuse an existing tag at the tested commit, including annotated tags", async () => {
  for (const type of ["commit", "tag"]) {
    const item = fixture({ refs: [{ ref, object: { type, sha: type === "tag" ? "b".repeat(40) : sha } }] });
    await publishRelease(item.input);
    assert.equal(item.calls.some(args => args.includes("POST")), false);
    assert.deepEqual(item.calls[1], ["api", `repos/{owner}/{repo}/commits/${tag}`]);
    assert.equal(item.calls.at(-1)[0], "release");
  }
});

test("a pushed tag is verified without creating or moving it", async () => {
  const item = fixture({ event: "push", refs: [{ ref }] });
  await publishRelease(item.input);
  assert.equal(item.calls.some(args => args.includes("POST")), false);
  assert.equal(item.calls.at(-1)[0], "release");
  const deleted = fixture({ event: "push" });
  await assert.rejects(publishRelease(deleted.input), /no longer exists/);
  assert.equal(deleted.calls.length, 1);
});

test("tags at another commit and tags moved during publication are never released or overwritten", async () => {
  for (const refs of [[{ ref }], []]) {
    const item = fixture({ refs, remoteSha: "b".repeat(40) });
    await assert.rejects(publishRelease(item.input), /does not point to the tested commit/);
    assert.equal(item.calls.some(args => args[0] === "release"), false);
    assert.equal(item.calls.some(args => args.includes("PATCH") || args.includes("DELETE")), false);
  }
});

test("a similarly named tag does not prevent creating the exact requested tag", async () => {
  const item = fixture({ refs: [{ ref: `${ref}-rc.1` }, { ref: `${ref}-old` }] });
  await publishRelease(item.input);
  assert.equal(item.calls.some(args => args.includes(`ref=${ref}`)), true);
});

test("GitHub errors stop publication without fallback, overwrites or cleanup writes", async () => {
  for (const [fail, count] of [["read", 1], ["create", 2], ["resolve", 3], ["publish", 4]]) {
    const item = fixture({ fail });
    await assert.rejects(publishRelease(item.input), new RegExp(`Synthetic ${fail} failure`));
    assert.equal(item.calls.length, count);
  }
  const invalid = fixture({ refs: { message: "Unexpected response" } });
  await assert.rejects(publishRelease(invalid.input), /invalid tag metadata/);
  assert.equal(invalid.calls.length, 1);
});

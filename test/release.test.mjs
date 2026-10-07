import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeReleaseTag } from "../scripts/check-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { CURRENT_VERSION, REPOSITORY } from "../src/updates.mjs";
import { archiveName, hash } from "../scripts/package.mjs";
import { home } from "./install-fixtures.mjs";

const tag = `v${CURRENT_VERSION}`;
const sha = "a".repeat(40);
const ref = `refs/tags/${tag}`;
const certificateIdentity = `https://github.com/${REPOSITORY}/.github/workflows/release.yml@${ref}`;
const url = `https://github.com/example/repo/releases/tag/${tag}`;

function missingAttestation(missingTag = tag, operation = "verify") {
  const message = operation === "verify-asset" ? "no attestations found" : "no attestations";
  const stderr = `${message} for tag ${missingTag} (sha1:${"b".repeat(40)})\n`;
  return Object.assign(new Error(stderr.trim()), { code: 1, stderr });
}

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
  pages = [[]], listResponse, fail, attestedIdentity = certificateIdentity,
  verificationErrors = [],
} = {}) {
  const directory = await home(t);
  const archive = archiveName(tag);
  const content = "Synthetic archive; package integration tests validate the real archive.";
  await writeFile(join(directory, archive), content);
  await writeFile(join(directory, "SHA256SUMS"), `${hash(content)}  ${archive}\n`);
  const calls = [];
  const responses = [];
  const waits = [];
  const logs = [];
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
    } else if (args[0] === "attestation" && args[1] === "verify") {
      operation = "provenance";
      assert.ok(args.includes("--cert-identity"), "The verifier must receive an exact certificate identity.");
      if (args[args.indexOf("--cert-identity") + 1] !== attestedIdentity) {
        throw new Error("Synthetic certificate identity mismatch");
      }
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
    const error = fail === operation ? new Error(`Synthetic ${operation} failure`) :
      ["verify", "verify-asset"].includes(operation) ? verificationErrors.shift() : undefined;
    responses.push({ args, stdout: result, stderr: error?.stderr, code: error ? error.code ?? 1 : 0 });
    if (error) throw error;
    return result;
  };
  return {
    calls, responses, directory, waits, logs,
    input: { tag, sha, event: "push", ref, directory, run,
      sleep: async delay => { waits.push(delay); }, log: message => logs.push(message) },
  };
}

test("tagged releases use one upload-and-publish command without a tag-based edit", async t => {
  const item = await fixture(t);
  assert.equal(await publishRelease({ ...item.input, sleep: async delay => {
    assert.equal(item.calls.at(-1)[1], "create", "The initial delay must follow successful publication.");
    await item.input.sleep(delay);
  } }), url);
  assert.deepEqual(item.waits, [5_000]);
  assert.deepEqual(item.logs, [
    `Waiting 5s before verifying published release ${tag} (attempt 1/4).`,
  ]);
  assert.deepEqual(item.calls, [
    ["api", `repos/{owner}/{repo}/commits/${tag}`],
    ["api", `repos/{owner}/{repo}/compare/${sha}...main`],
    ["api", "--paginate", "repos/{owner}/{repo}/releases?per_page=100",
      "--jq", "map({tag_name, draft}) | tojson"],
    ["release", "verify", "--help"],
    ["release", "verify-asset", "--help"],
    ["attestation", "verify", join(item.directory, archiveName(tag)),
      "--repo", REPOSITORY, "--hostname", "github.com",
      "--cert-identity", certificateIdentity,
      "--source-ref", ref, "--source-digest", sha, "--signer-digest", sha,
      "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1"],
    ["release", "create", tag, join(item.directory, archiveName(tag)), join(item.directory, "SHA256SUMS"),
      "--verify-tag", "--generate-notes", "--title", tag, "--latest"],
    ["release", "verify", tag],
    ["release", "verify-asset", tag, join(item.directory, archiveName(tag))],
    ["release", "verify-asset", tag, join(item.directory, "SHA256SUMS")],
  ]);
});

test("missing release attestations retry verification with bounded backoff, never publication", async t => {
  for (const failures of [1, 3]) {
    const item = await fixture(t, { verificationErrors: Array(failures).fill(missingAttestation()) });
    assert.equal(await publishRelease(item.input), url);
    assert.deepEqual(item.waits, [5_000, 5_000, 10_000, 20_000].slice(0, failures + 1));
    assert.equal(item.logs.length, failures + 1);
    assert.match(item.logs.at(-1), new RegExp(`attempt ${failures + 1}/4`));
    assert.equal(item.calls.filter(args => args[1] === "create").length, 1);
    assert.deepEqual(item.calls.slice(7), [
      ...Array.from({ length: failures + 1 }, () => ["release", "verify", tag]),
      ["release", "verify-asset", tag, join(item.directory, archiveName(tag))],
      ["release", "verify-asset", tag, join(item.directory, "SHA256SUMS")],
    ]);
  }
});

test("a missing attestation during either asset check retries only read-only verification", async t => {
  for (const failedAsset of [0, 1]) {
    const item = await fixture(t, {
      verificationErrors: [...Array(failedAsset + 1).fill(undefined), missingAttestation(tag, "verify-asset")],
    });
    assert.equal(await publishRelease(item.input), url);
    assert.deepEqual(item.waits, [5_000, 5_000]);
    assert.equal(item.calls.filter(args => args[1] === "create").length, 1);
    const verification = [
      ["release", "verify", tag],
      ["release", "verify-asset", tag, join(item.directory, archiveName(tag))],
      ["release", "verify-asset", tag, join(item.directory, "SHA256SUMS")],
    ];
    assert.deepEqual(item.calls.slice(7), [...verification.slice(0, failedAsset + 2), ...verification]);
  }
});

test("attestation verification fails closed after four attempts and 40 seconds of waiting", async t => {
  const error = missingAttestation();
  const item = await fixture(t, { verificationErrors: Array(4).fill(error) });
  await assert.rejects(publishRelease(item.input), received => received === error);
  assert.deepEqual(item.waits, [5_000, 5_000, 10_000, 20_000]);
  assert.equal(item.waits.reduce((total, delay) => total + delay, 0), 40_000);
  assert.equal(item.logs.length, 4);
  assert.match(item.logs.at(-1), /attempt 4\/4/);
  assert.equal(item.calls.filter(args => args[1] === "create").length, 1);
  assert.deepEqual(item.calls.slice(7), Array.from({ length: 4 }, () => ["release", "verify", tag]));
});

test("verification errors other than this tag's missing attestation are never retried", async t => {
  const errors = [
    ...["verify", "verify-asset"].flatMap(operation => {
      const missing = missingAttestation(tag, operation);
      return [
        new Error(missing.message),
        Object.assign(missingAttestation(tag, operation), { code: 2 }),
        missingAttestation(`${tag}-other`, operation),
        Object.assign(missingAttestation(tag, operation), { stderr: `${missing.stderr}Invalid signature\n` }),
        Object.assign(missingAttestation(tag, operation), { stderr: missing.stderr.replace("sha1:", "sha256:") }),
        Object.assign(missingAttestation(tag, operation), { stderr: missing.stderr.replace("b".repeat(40), "b".repeat(39)) }),
      ];
    }),
    ...["Invalid signature", "Artifact digest mismatch", "HTTP 403: Forbidden",
      "network timeout", "unknown command verify"].map(stderr =>
      Object.assign(new Error(stderr), { code: 1, stderr })),
  ];
  for (const error of errors) {
    for (const successfulChecks of [0, 1, 2]) {
      const item = await fixture(t, {
        verificationErrors: [...Array(successfulChecks).fill(undefined), error],
      });
      await assert.rejects(publishRelease(item.input), received => received === error);
      assert.deepEqual(item.waits, [5_000], error.message);
      assert.equal(item.logs.length, 1);
      assert.equal(item.calls.length, 8 + successfulChecks);
      assert.equal(item.calls.filter(args => args[1] === "create").length, 1);
    }
  }
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
    ["help-verify-asset", 5], ["provenance", 6], ["create", 7], ["verify", 8], ["verify-asset", 9],
  ]) {
    const item = await fixture(t, { fail });
    await assert.rejects(publishRelease(item.input), new RegExp(`Synthetic ${fail} failure`));
    assert.equal(item.calls.length, count);
    assert.deepEqual(item.waits, count < 8 ? [] : [5_000]);
    assert.equal(item.calls.some(args => args.includes("--clobber") || args.includes("DELETE") || args.includes("POST")), false);
    assert.equal(item.calls.some(args => args[0] === "release" && !["create", "verify", "verify-asset"].includes(args[1])), false);
    assert.ok(item.calls.filter(args => args[1] === "create").length <= 1);
  }
});

test("the release CLI reads its environment, reports success and stops on command failures", async t => {
  const script = fileURLToPath(new URL("../scripts/publish-release.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/gh-preload.mjs", import.meta.url));
  for (const scenario of [
    {}, { fail: "provenance" }, { fail: "create" }, { fail: "verify" },
    { verificationErrors: [missingAttestation()] },
    { verificationErrors: [undefined, missingAttestation(tag, "verify-asset")] },
    { verificationErrors: [undefined, undefined, missingAttestation(tag, "verify-asset")] },
    { verificationErrors: Array(4).fill(missingAttestation()), rejects: true },
    { verificationErrors: Array.from({ length: 4 }, () =>
      [undefined, missingAttestation(tag, "verify-asset")]).flat(), rejects: true },
  ]) {
    const fails = scenario.fail || scenario.rejects;
    const item = await fixture(t, scenario);
    if (fails) await assert.rejects(publishRelease(item.input), /Synthetic|no attestations/);
    else await publishRelease(item.input);
    const state = join(item.directory, "fake-gh.json");
    // The CLI uses dist/ relative to its cwd.
    const cwd = await realpath(await home(t));
    await mkdir(join(cwd, "dist"));
    for (const file of [archiveName(tag), "SHA256SUMS"]) {
      await copyFile(join(item.directory, file), join(cwd, "dist", file));
    }
    const expected = item.responses.map(response => ({
      ...response, args: response.args.map(arg => arg.replace(item.directory, join(cwd, "dist"))),
    }));
    await writeFile(state, JSON.stringify({ responses: expected, calls: [], waits: [] }));
    const options = { cwd, env: { ...process.env, NOTIFICATIONS_TEST_GH: state,
      GITHUB_SHA: sha, GITHUB_EVENT_NAME: "push", GITHUB_REF: ref } };
    const run = () => promisify(execFile)(process.execPath, ["--import", preload, script, tag], options);
    if (fails) {
      await assert.rejects(run(), error => error.code === 1 && error.stderr.includes("Release stopped:"));
    } else {
      const { stdout, stderr } = await run();
      assert.equal(stdout, `${url}\n`);
      assert.equal(stderr, item.logs.map(message => `${message}\n`).join(""));
    }
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).calls, expected.map(response => response.args));
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).waits, item.waits);
    options.env.GITHUB_REF = "refs/heads/main";
    await assert.rejects(run(), error => error.code === 1 && error.stderr.includes("matching release-tag push"));
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).calls, expected.map(response => response.args));
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")).waits, item.waits);
  }
});

test("provenance verification failures never create a release or execute the archive", async t => {
  for (const reason of [
    "No attestations found", "Artifact digest mismatch", "Invalid signature",
    "SourceRepository mismatch", "Signer workflow mismatch", "Source ref mismatch",
    "Source digest mismatch", "Signer digest mismatch", "Self-hosted runner denied",
    "Predicate type mismatch", "unknown command attestation", "unknown flag: --source-digest",
    "unknown flag: --cert-identity",
  ]) {
    const item = await fixture(t);
    const error = new Error(reason);
    const run = async args => {
      const result = await item.input.run(args);
      if (args[0] === "attestation") throw error;
      return result;
    };
    await assert.rejects(publishRelease({ ...item.input, run }), received => received === error);
    assert.equal(item.calls.length, 6, reason);
    assert.equal(item.calls.at(-1)[0], "attestation");
    assert.ok(item.calls.every(args => args[0] === "api" ||
      args[0] === "attestation" || args.includes("--help")), reason);
  }
});

test("the publisher's exact certificate policy rejects lookalike workflow names and refs", async t => {
  for (const attestedIdentity of [
    certificateIdentity.replace("release.yml@", "release.yml.other.yml@"),
    certificateIdentity.replace("release.yml@", "release.yaml@"),
    certificateIdentity.replace(REPOSITORY, "other/repository"),
    certificateIdentity.replace(ref, "refs/heads/main"),
    `${certificateIdentity}-rc.1`,
    `${certificateIdentity}@refs/heads/other`,
  ]) {
    const item = await fixture(t, { attestedIdentity });
    await assert.rejects(publishRelease(item.input), /Synthetic certificate identity mismatch/);
    assert.equal(item.calls.at(-1)[0], "attestation");
    assert.equal(item.calls.some(args => args[1] === "create"), false);
    assert.equal(item.calls.some(args => args.includes("--signer-workflow") || args.includes("--cert-identity-regex")), false);
  }
});

test("PR checks validate packages without publishing, and tag checks precede publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const tests = await readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\n {2}push:\n {4}tags: \["v\*"\]/);
  assert.match(workflow, /\npermissions:\n {2}contents: read\n\nconcurrency:/);
  assert.doesNotMatch(workflow, /workflow_dispatch|branches:/);
  assert.doesNotMatch(tests, /publish-release|contents: write|GH_TOKEN/);
  assert.match(tests, /name: Validate release packaging\n {8}run: \|\n {10}npm run build\n {10}npm run test:package/);
  assert.match(tests, /runs-on: windows-latest/);
  assert.match(tests, /node --test test\/platform\.test\.mjs test\/settings\.test\.mjs test\/notifier\.test\.mjs/);
  assert.match(workflow, /checks:\n {4}needs: validate\n {4}uses: \.\/\.github\/workflows\/tests\.yml/);
  assert.match(workflow, /build:\n {4}needs: \[validate, checks\]/);
  assert.match(workflow, /publish:\n {4}needs: \[validate, build\]/);
  const buildJob = workflow.slice(workflow.indexOf("\n  build:"), workflow.indexOf("\n  publish:"));
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
  assert.match(buildJob, /permissions:\n {6}contents: read\n {6}attestations: write\n {6}id-token: write\n {4}outputs:/);
  assert.doesNotMatch(buildJob, /contents: write|GH_TOKEN/);
  assert.match(buildJob, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/);
  assert.match(buildJob, /subject-path: dist\/github-notifications-\$\{\{ github\.ref_name \}\}\.tar\.gz/);
  assert.doesNotMatch(buildJob, /continue-on-error|predicate:|predicate-path:|subject-checksums:/);
  assert.match(publishJob, /permissions:\n {6}contents: write\n {6}attestations: read\n {4}env:/);
  assert.doesNotMatch(publishJob, /id-token:|attestations: write|actions\/attest@/);
  assert.doesNotMatch(publishJob, /npm (ci|install)|build-release\.mjs|package\.integration|node install\.mjs/);
  assert.match(publishJob, /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);
  assert.match(publishJob, /digest-mismatch: error/);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  assert.ok(workflow.indexOf("git merge-base --is-ancestor") < workflow.indexOf("node scripts/check-release.mjs"));
  const commands = ["scripts/check-release.mjs", "npm ci",
    "scripts/build-release.mjs", "node --test test/package.integration.mjs",
    "actions/attest@", "actions/upload-artifact@", "scripts/publish-release.mjs"];
  const positions = commands.map(command => workflow.indexOf(command));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
});

test("documented shell installation enforces provenance before extraction or execution", {
  skip: process.platform === "win32" && "The documented POSIX-shell command is tested on Linux and macOS.",
}, async t => {
  const instructions = await readFile(new URL("../docs/installation.md", import.meta.url), "utf8");
  const command = instructions.match(/```sh\n( {3}tag=v[\s\S]+?) {3}```/)[1];
  const manualTag = command.match(/tag=(v[0-9.]+)/)[1];
  const stub = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify([name, ...args]) + "\\n");
if (name === "gh" && args[0] === "api") {
  process.stdout.write(process.env.TEST_COMMIT + "\\n");
}
if (name === "gh" && args[0] === process.env.TEST_FAIL) process.exit(1);
`;
  for (const { commit = sha, fail = "", succeeds = false } of [
    { succeeds: true }, { fail: "attestation" }, { fail: "api" }, { commit: "" },
    { commit: "null" }, { commit: "main" }, { commit: "a".repeat(39) },
  ]) {
    const directory = await home(t);
    const bin = join(directory, "bin");
    const log = join(directory, "calls.jsonl");
    await mkdir(bin);
    for (const name of ["gh", "sha256sum", "tar", "node"]) {
      await writeFile(join(bin, name), stub, { mode: 0o755 });
    }
    const operation = promisify(execFile)("sh", ["-c", command], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log, TEST_COMMIT: commit, TEST_FAIL: fail },
    });
    if (succeeds) await operation;
    else await assert.rejects(operation, { code: 1 });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const verification = calls.find(call => call[0] === "gh" && call[1] === "attestation");
    if (verification) {
      assert.deepEqual(verification, ["gh", "attestation", "verify", `github-notifications-${manualTag}.tar.gz`,
        "--repo", REPOSITORY, "--hostname", "github.com",
        "--cert-identity", `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/tags/${manualTag}`,
        "--source-ref", `refs/tags/${manualTag}`, "--source-digest", sha,
        "--signer-digest", sha, "--deny-self-hosted-runners",
        "--predicate-type", "https://slsa.dev/provenance/v1"]);
    }
    assert.equal(Boolean(verification), succeeds || fail === "attestation");
    assert.equal(calls.some(call => call[0] === "tar"), succeeds);
    assert.equal(calls.some(call => call[0] === "node"), succeeds);
    if (succeeds) {
      assert.ok(calls.indexOf(verification) < calls.findIndex(call => call[0] === "tar"));
      assert.deepEqual(calls.at(-1), ["node", "install.mjs", manualTag]);
    }
  }
});

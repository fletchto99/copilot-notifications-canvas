import test from "node:test";
import assert from "node:assert/strict";
import { loadDevelopmentInfo } from "../src/assets.mjs";
import metadata from "../version.json" with { type: "json" };

test("development metadata reads the exact branch from the extension checkout, not the process directory", async () => {
  const signal = new AbortController().signal;
  const development = await loadDevelopmentInfo({
    signal,
    log: () => assert.fail("A valid branch must not log a warning"),
    run: async (args, options) => {
      assert.deepEqual(args, ["symbolic-ref", "--quiet", "HEAD"]);
      assert.equal(options.cwd.href, new URL("../", import.meta.url).href);
      assert.equal(options.encoding, "utf8");
      assert.equal(options.timeout, 2000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.signal, signal);
      return "refs/heads/feature/footer-details\n";
    },
  });
  assert.deepEqual(development, { version: metadata.version, branch: "feature/footer-details" });
});

test("a detached source checkout remains visibly identified as development", async () => {
  const development = await loadDevelopmentInfo({
    run: async () => { throw Object.assign(new Error("Detached"), { code: 1 }); },
    log: () => assert.fail("Detached HEAD is not a failure"),
  });
  assert.deepEqual(development, { version: metadata.version, branch: "detached HEAD" });
});

test("missing Git, failed commands and invalid refs show an unavailable branch with a sanitized warning", async () => {
  for (const result of [
    Object.assign(new Error("Synthetic private path and stderr"), { code: "ENOENT" }),
    Object.assign(new Error("Synthetic private path and stderr"), { code: 128 }),
    Object.assign(new Error("Synthetic private path and stderr"), { killed: true }),
    "refs/tags/v1.0.0\n",
    "refs/heads/\n",
  ]) {
    const logs = [];
    const development = await loadDevelopmentInfo({
      run: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
      log: (message, options) => logs.push({ message, options }),
    });
    assert.deepEqual(development, { version: metadata.version, branch: "branch unavailable" });
    assert.deepEqual(logs, [{
      message: "Could not read the development branch for the notifications footer.",
      options: { level: "warning" },
    }]);
  }
});

test("cancelling development metadata loading propagates the abort without logging", async () => {
  const controller = new AbortController();
  const error = new Error("Synthetic abort");
  await assert.rejects(loadDevelopmentInfo({
    signal: controller.signal,
    run: async () => { controller.abort(); throw error; },
    log: () => assert.fail("Cancellation must not log a warning"),
  }), error);
});

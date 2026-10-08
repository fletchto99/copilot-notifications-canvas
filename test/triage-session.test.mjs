import test from "node:test";
import assert from "node:assert/strict";
import { delimiter, join, resolve } from "node:path";
import { copilotPath, runTriageSession } from "../src/triage-session.mjs";
import { InboxError } from "../src/model.mjs";

function fixture(options = {}) {
  const controller = new AbortController();
  const calls = { removed: [], logs: [], stopped: 0, sent: 0 };
  const tools = [{ name: "list_shown_notifications" }, { name: "read_notification_context" }];
  class CopilotClient {
    constructor(config) { calls.client = config; }
    async createSession(config) {
      calls.session = config;
      if (options.create) await options.create(config, controller);
      return {
        rpc: { tools: {
          initializeAndValidate: async () => { if (options.initializeError) throw new Error("PRIVATE"); },
          getCurrentMetadata: async () => ({ tools: options.offered === undefined ? tools : options.offered }),
        } },
        sendAndWait: async input => {
          calls.sent++;
          calls.input = input;
          if (options.send) return options.send(config, controller);
          return { data: { content: '{"recommendations":[]}' } };
        },
      };
    }
    async stop() {
      calls.stopped++;
      if (options.stopError) throw new Error("PRIVATE");
      return options.cleanupErrors ? [new Error("PRIVATE")] : [];
    }
  }
  const dependencies = {
    loadSdk: async () => ({ CopilotClient, RuntimeConnection: { forStdio: value => ({ kind: "stdio", ...value }) } }),
    findCli: async () => resolve("synthetic-copilot"),
    temporary: async () => resolve("synthetic-home"),
    remove: async path => { calls.removed.push(path); if (options.removeError) throw new Error("PRIVATE"); },
    log: message => calls.logs.push(message),
  };
  const run = () => runTriageSession({ tools, schema: { type: "object" }, signal: controller.signal }, dependencies);
  return { calls, dependencies, controller, run };
}

test("the isolated session disables ambient capabilities, verifies offered tools, and removes its own workspace", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { recommendations: [] });
  assert.equal(f.calls.client.mode, "empty");
  assert.equal(f.calls.client.workingDirectory, f.calls.client.baseDirectory);
  assert.equal(f.calls.client.logLevel, "none");
  const session = f.calls.session;
  for (const field of ["enableConfigDiscovery", "enableFileHooks", "enableOnDemandInstructionDiscovery",
    "enableHostGitOperations", "enableSessionStore", "enableSkills", "requestExtensions", "requestCanvasRenderer"]) {
    assert.equal(session[field], false, field);
  }
  assert.equal(session.remoteSession, "off");
  assert.deepEqual(session.memory, { enabled: false });
  assert.deepEqual(session.infiniteSessions, { enabled: false });
  assert.deepEqual(session.excludedTools, ["builtin:*", "mcp:*"]);
  assert.equal(session.onPermissionRequest({ kind: "custom-tool", toolName: "read_notification_context" }).kind, "approve-once");
  for (const request of [{ kind: "shell" }, { kind: "read" },
    { kind: "custom-tool", toolName: "write_notification" }, { kind: "hook", toolName: "read_notification_context" }]) {
    assert.equal(session.onPermissionRequest(request).kind, "reject");
  }
  f.controller.abort();
  assert.equal(session.onPermissionRequest({ kind: "custom-tool", toolName: "read_notification_context" }).kind, "reject");
  assert.equal(f.calls.stopped, 1);
  assert.deepEqual(f.calls.removed, [resolve("synthetic-home")]);
  assert.match(f.calls.input.prompt, /untrusted data/);
  assert.deepEqual(f.calls.input.responseSchema, { type: "object" });
});

test("the adapter refuses missing or unexpected offered tools before sending a prompt", async () => {
  for (const offered of [null, [], [{ name: "shell" }]]) {
    const f = fixture({ offered });
    await assert.rejects(f.run(), { code: "triage_tools" });
    assert.equal(f.calls.sent, 0);
    assert.equal(f.calls.stopped, 1);
  }
});

test("runtime, protocol, missing-response and JSON failures are sanitized", async () => {
  for (const options of [
    { create: async () => { throw new Error("PRIVATE"); } },
    { initializeError: true },
    { send: async () => undefined },
    { send: async () => ({ data: { content: "PRIVATE" } }) },
    { send: async config => {
      config.onEvent({ type: "session.idle" });
      config.onEvent({ type: "session.error" });
      return { data: { content: "{}" } };
    } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), error => error.code === "triage_session" && !error.message.includes("PRIVATE"));
    assert.equal(f.calls.stopped, 1);
    assert.equal(f.calls.removed.length, 1);
  }
});

test("cancellation before startup, during startup and during inference cleans up only the owned client", async () => {
  const reason = new InboxError("triage_cancelled", "Cancelled.", 409);
  const early = fixture();
  early.controller.abort(reason);
  await assert.rejects(early.run(), error => error === reason);
  assert.equal(early.calls.client, undefined);
  for (const stage of ["create", "send"]) {
    const f = fixture({ [stage]: async (config, controller) => {
      controller.abort(reason);
      if (stage === "send") return { data: { content: "{}" } };
    } });
    await assert.rejects(f.run(), error => error === reason);
    assert.equal(f.calls.stopped, 1);
    assert.equal(f.calls.removed.length, 1);
  }
});

test("cleanup failures are explicit and never delete a workspace while stopping has failed", async () => {
  for (const options of [{ cleanupErrors: true }, { stopError: true }, { removeError: true },
    { stopError: true, send: async (config, controller) => { controller.abort(); throw new Error("PRIVATE"); } }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), { code: "triage_cleanup" });
    assert.equal(f.calls.logs.length, 1);
    assert.equal(f.calls.removed.length, options.removeError ? 1 : 0);
  }
});

test("missing SDK and CLI prerequisites fail without creating a temporary session", async () => {
  const f = fixture();
  f.dependencies.loadSdk = async () => { throw new Error("SDK unavailable"); };
  await assert.rejects(f.run(), { code: "triage_session" });
  const missing = fixture();
  missing.dependencies.findCli = async () => { throw new InboxError("copilot_missing", "Install CLI.", 503); };
  await assert.rejects(missing.run(), { code: "copilot_missing" });
  assert.equal(missing.calls.client, undefined);
});

test("CLI discovery uses explicit absolute executables or PATH, never a shell or runtime download", async () => {
  const root = resolve("synthetic-bin");
  const cli = join(root, "copilot");
  const attempts = [];
  const check = async path => {
    attempts.push(path);
    if (path !== cli) throw Object.assign(new Error(), { code: "ENOENT" });
  };
  assert.equal(await copilotPath({
    env: { PATH: ["", "relative", resolve("missing"), root].join(delimiter) }, platform: "darwin",
    check, resolve: async path => `${path}.js`,
  }), `${cli}.js`);
  assert.deepEqual(attempts, [join(resolve("missing"), "copilot"), cli]);
  assert.equal(await copilotPath({ env: { COPILOT_CLI_PATH: cli }, check, resolve: async path => path }), cli);
  const windows = join(root, "copilot.exe");
  assert.equal(await copilotPath({ env: { PATH: root }, platform: "win32",
    check: async () => {}, resolve: async path => path }), windows);
  for (const env of [{}, { COPILOT_CLI_PATH: "relative" }, { COPILOT_CLI_PATH: resolve("missing") }]) {
    await assert.rejects(copilotPath({ env, check }), { code: "copilot_missing" });
  }
  await assert.rejects(copilotPath({ env: { COPILOT_CLI_PATH: cli },
    check: async () => { throw Object.assign(new Error(), { code: "EIO" }); } }), { code: "EIO" });
});

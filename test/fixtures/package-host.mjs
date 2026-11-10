import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { register, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { host } from "./sdk.mjs";

// Only this isolated test provider gets a controllable clock; timers still run normally.
const realNow = Date.now;
let fixedTime;
Date.now = () => fixedTime ?? realNow();

const pending = new Map();
const toolRequests = new Map();
let nextId = 0;
childProcess.execFile = (command, args, options, callback) => {
  assert.ok(command === "gh" || command === "git" && process.argv[3] === "copilot",
    "Packaged browser tests must not launch native commands");
  const id = ++nextId;
  const complete = (error, stdout = "") => {
    if (!pending.delete(id)) return;
    options.signal?.removeEventListener("abort", abort);
    callback(error, stdout, "");
  };
  const abort = () => complete(new Error("Synthetic request aborted"));
  pending.set(id, complete);
  if (options.signal?.aborted) return abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  process.send({ type: command, id, args, ...(command === "git" ? { cwd: options.cwd } : {}) });
};
syncBuiltinESMExports();
host.session = {
  workspacePath: process.env.COPILOT_HOME,
  on: () => () => {},
  log: (message, options) => process.send({ type: "log", message, options }),
};
if (process.argv[3] === "copilot") {
  const call = (method, input) => new Promise((resolve, reject) => {
    const id = ++nextId;
    toolRequests.set(id, { resolve, reject });
    process.send({ type: "copilot", id, method, input });
  });
  host.session.rpc = { tools: {
    getCurrentMetadata: () => call("getCurrentMetadata"),
    execute: input => call("execute", input),
  } };
}
register(new URL("./sdk-loader.mjs", import.meta.url));
await import(pathToFileURL(process.argv[2]).href);
const canvas = host.registration.canvases[0];
process.on("message", async message => {
  if (message.type === "response") {
    pending.get(message.id)?.(message.error ? Object.assign(new Error(message.error), { code: message.code }) : null, message.stdout);
  } else if (message.type === "copilot-response") {
    const request = toolRequests.get(message.id);
    toolRequests.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  } else if (message.type === "set-time") {
    assert.ok(Number.isSafeInteger(message.now) && message.now >= 0);
    fixedTime = message.now;
    process.send({ type: "time-set", now: fixedTime });
  } else if (message.type === "close") {
    await canvas.onClose({ instanceId: "packaged-browser" });
    process.exit(0);
  }
});
const result = await canvas.open({ instanceId: "packaged-browser", input: {} });
process.send({ type: "ready", url: result.url });

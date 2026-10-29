import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { register, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { host } from "./sdk.mjs";

const pending = new Map();
// Only the fake SDK sees this executable; it never starts a native process.
process.env.COPILOT_CLI_PATH = process.execPath;
let nextId = 0;
childProcess.execFile = (command, args, options, callback) => {
  assert.equal(command, "gh", "Packaged browser tests must not launch native commands");
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
  process.send({ type: "gh", id, args });
};
syncBuiltinESMExports();
host.session = {
  workspacePath: process.env.COPILOT_HOME,
  log: (message, options) => process.send({ type: "log", message, options }),
};
register(new URL("./sdk-loader.mjs", import.meta.url));
await import(pathToFileURL(process.argv[2]).href);
const canvas = host.registration.canvases[0];
process.on("message", async message => {
  if (message.type === "response") {
    pending.get(message.id)?.(message.error ? new Error(message.error) : null, message.stdout);
  } else if (message.type === "close") {
    await canvas.onClose({ instanceId: "packaged-browser" });
    process.exit(0);
  }
});
const result = await canvas.open({ instanceId: "packaged-browser", input: {} });
process.send({ type: "ready", url: result.url });

import { execFile, fork } from "node:child_process";
import { on, once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extract } from "tar";
import { verifyArchive } from "../../scripts/package.mjs";
import { CURRENT_VERSION } from "../../src/provider/updates.mjs";

export async function startPackagedCanvas(root, run, log, tools) {
  const directory = join(root, "package");
  const home = join(root, "home");
  await mkdir(directory);
  const tag = `v${CURRENT_VERSION}`;
  const [archive] = await verifyArchive(resolve("dist"), tag);
  await extract({ file: archive, cwd: directory });
  await promisify(execFile)(process.execPath, [join(directory, "install.mjs"), tag], {
    env: { ...process.env, COPILOT_HOME: home },
  });
  const child = fork(fileURLToPath(new URL("../fixtures/package-host.mjs", import.meta.url)),
    [join(home, "extensions", "github-notifications", "extension.mjs"), ...(tools ? ["copilot"] : [])],
    { env: { ...process.env, COPILOT_HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("message", async message => {
    if (message.type === "log") return log(message.message, message.options);
    if (message.type === "copilot") {
      let response;
      try {
        response = { result: await tools[message.method](message.input) };
      } catch {
        response = { error: "Synthetic host tool failure" };
      }
      if (child.connected) child.send({ type: "copilot-response", id: message.id, ...response });
      return;
    }
    if (!["gh", "git"].includes(message.type)) return;
    let response;
    try {
      response = { stdout: message.type === "git"
        ? await tools.runGit({ args: message.args, cwd: message.cwd }) : await run(message.args) };
    } catch (error) {
      response = { error: error.message, code: error.code };
    }
    if (child.connected) child.send({ type: "response", id: message.id, ...response });
  });
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        child.send({ type: "close" });
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    if (child.exitCode !== 0) {
      throw new Error(`Packaged provider failed (${child.signalCode ?? child.exitCode}): ${stderr}`);
    }
  }
  async function setTime(now) {
    if (!child.connected) throw new Error("Cannot set the clock of a disconnected packaged provider.");
    const messages = on(child, "message", { signal: AbortSignal.timeout(5000), close: ["exit"] });
    try {
      child.send({ type: "set-time", now });
      for await (const [message] of messages) {
        if (message.type === "time-set" && message.now === now) return;
      }
      throw new Error("Packaged provider exited before acknowledging its test clock.");
    } finally {
      await messages.return();
    }
  }
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Packaged provider did not open: ${stderr}`)), 10_000);
      const ready = message => { if (message.type === "ready") finish(null, message.url); };
      const exited = () => finish(new Error(`Packaged provider exited: ${stderr}`));
      const finish = (error, url) => {
        clearTimeout(timeout);
        child.off("message", ready);
        child.off("exit", exited);
        child.off("error", finish);
        error ? reject(error) : resolve(url);
      };
      child.on("message", ready);
      child.once("exit", exited);
      child.once("error", finish);
    });
    return { url, close, setTime };
  } catch (error) {
    await close();
    throw error;
  }
}

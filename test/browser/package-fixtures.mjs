import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extract } from "tar";
import { verifyArchive } from "../../scripts/package.mjs";
import { CURRENT_VERSION } from "../../src/updates.mjs";

export async function startPackagedCanvas(root, run, log) {
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
    [join(home, "extensions", "github-notifications", "extension.mjs")],
    { env: { ...process.env, COPILOT_HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("message", async message => {
    if (message.type === "log") return log(message.message, message.options);
    if (message.type !== "gh") return;
    let response;
    try {
      response = { stdout: await run(message.args) };
    } catch (error) {
      response = { error: error.message };
    }
    if (child.connected) child.send({ type: "response", id: message.id, ...response });
  });
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      child.send({ type: "close" });
      const [code, signal] = await exited;
      if (code !== 0) throw new Error(`Packaged provider failed (${signal ?? code}): ${stderr}`);
    } finally {
      clearTimeout(timeout);
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
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

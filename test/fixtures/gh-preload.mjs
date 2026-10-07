import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = childProcess.execFile;
const fake = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
childProcess.execFile = (command, args, options, callback) => {
  assert.equal(command, "gh", "CLI tests must never launch an unexpected command");
  return execute(process.execPath, [fake, ...args], options, callback);
};
childProcess.execFile[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
  childProcess.execFile(command, args, options, (error, stdout, stderr) =>
    error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
});
timers.setTimeout = async delay => {
  const path = process.env.NOTIFICATIONS_TEST_GH;
  const state = JSON.parse(await readFile(path, "utf8"));
  state.waits.push(delay);
  await writeFile(path, JSON.stringify(state));
};
syncBuiltinESMExports();

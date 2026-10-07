import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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
    error ? reject(error) : resolve({ stdout, stderr }));
});
syncBuiltinESMExports();

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const path = process.env.NOTIFICATIONS_TEST_GH;
assert.ok(path, "A synthetic CLI response file is required");
const state = JSON.parse(await readFile(path, "utf8"));
const args = process.argv.slice(2);
const response = state.responses[state.calls.length];
assert.ok(response, "Unexpected GitHub CLI invocation");
assert.deepEqual(args, response.args);
state.calls.push(args);
await writeFile(path, JSON.stringify(state));
process.stdout.write(response.stdout ?? "");
process.stderr.write(response.stderr ?? "");
process.exitCode = response.code ?? 0;

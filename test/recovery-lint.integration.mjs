import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import stylelint from "stylelint";
import { GitHubClient } from "../src/github.mjs";
import { Inbox } from "../src/inbox.mjs";
import { startServer } from "../src/server.mjs";

const eslint = new ESLint({ cwd: fileURLToPath(new URL("../", import.meta.url)) });
const lintScript = async code => {
  const [result] = await eslint.lintText(code, { filePath: fileURLToPath(new URL("../src/app.mjs", import.meta.url)) });
  return result.messages;
};
const lintStyles = code => stylelint.lint({
  code, configFile: fileURLToPath(new URL("../stylelint.config.mjs", import.meta.url)),
});

test("served recovery JavaScript and CSS pass the browser ESLint and Stylelint rules", async t => {
  let githubCalls = 0;
  const inbox = new Inbox(new GitHubClient({ run: async () => {
    githubCalls++;
    throw new Error("Recovery lint must not request GitHub data");
  } }));
  t.after(() => inbox.close());
  const server = await startServer(inbox, {
    development: { version: "0.0.0", branch: "recovery-lint" },
    read: async () => { throw new Error("Synthetic missing renderer assets"); },
  });
  t.after(() => server.close());

  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Retrying in the background/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, "Lint every recovery script");
  assert.match(html, /<script type="module" src="\/startup\.mjs"><\/script>/);
  const script = await fetch(new URL("/startup.mjs", server.url));
  assert.equal(script.status, 200);
  const code = await script.text();
  assert.ok(code.trim(), "Recovery JavaScript must not be empty");
  assert.deepEqual(await lintScript(code), [], "Recovery JavaScript has lint errors or warnings");

  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  assert.ok(styles.length > 0, "Recovery CSS must be present");
  for (const [, code] of styles) {
    const result = await lintStyles(code);
    assert.deepEqual(result.results.flatMap(entry => entry.warnings), [], "Recovery CSS has lint errors or warnings");
    assert.equal(result.errored, false, "Stylelint could not validate recovery CSS");
  }
  assert.equal(githubCalls, 0);
});

test("recovery JavaScript checks detect syntax errors and use browser-only globals and runtime rules", async () => {
  assert.ok((await lintScript("const broken = ;")).some(message => message.fatal));
  for (const [code, ruleId] of [
    ["missingRecoveryFunction();", "no-undef"],
    ["process.exit(1);", "no-undef"],
    ["const unused = 1;", "no-unused-vars"],
    ['console.log("fixture");', "no-console"],
  ]) {
    assert.ok((await lintScript(code)).some(message => message.ruleId === ruleId), ruleId);
  }
  assert.deepEqual(await lintScript('window.addEventListener("pagehide", () => location.reload());'), []);
});

test("recovery CSS checks reject invalid properties, values and syntax while accepting host theme variables", async () => {
  for (const [code, rule] of [
    [".fixture {\n  colr: red;\n}\n", "property-no-unknown"],
    [".fixture {\n  display: red;\n}\n", "declaration-property-value-no-unknown"],
    [".fixture {", "CssSyntaxError"],
  ]) {
    const result = await lintStyles(code);
    assert.equal(result.errored, true);
    assert.ok(result.results.some(entry => entry.warnings.some(warning => warning.rule === rule)), rule);
  }
  const result = await lintStyles(".fixture {\n  color: var(--text-color-default, #1f2328);\n}\n");
  assert.equal(result.errored, false);
  assert.deepEqual(result.results.flatMap(entry => entry.warnings), []);
});

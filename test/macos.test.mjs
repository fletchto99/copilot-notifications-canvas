import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyDesktop } from "../src/notifier.mjs";

const run = promisify(execFile);
const unixTest = process.platform === "win32" ? test.skip : test;
const title = "example/widgets";
const body = 'Synthetic title "; $(never-run)';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "notifications-macos-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let failure;
  const execute = (program, args, options, done) => {
    calls.push({ program, args, options });
    (async () => {
      if (failure?.program === program) throw Object.assign(new Error("Private subprocess diagnostics"), { code: failure.code });
      if (program === "/usr/bin/plutil" && args.includes("json")) {
        return JSON.stringify({ CFBundleExecutable: "applet", OSAAppletShowStartupScreen: false, CompilerMetadata: "preserved" });
      }
      if (program === "/usr/bin/osacompile") {
        const app = args[args.indexOf("-o") + 1];
        await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
        await mkdir(join(app, "Contents", "Resources", "Scripts"), { recursive: true });
        await writeFile(join(app, "Contents", "MacOS", "applet"), "Synthetic applet runtime");
        await writeFile(join(app, "Contents", "Resources", "Scripts", "main.scpt"), args[args.indexOf("-e") + 1]);
        await writeFile(join(app, "Contents", "Info.plist"), "Synthetic compiler plist");
      }
    })().then(stdout => done(null, stdout ?? "", ""), error => done(error));
  };
  return {
    directory, calls,
    fail(program, code = "ENOENT") { failure = { program, code }; },
    async notify(overrides = {}) {
      await notifyDesktop({ directory, title, body, platform: "darwin", sound: "none", execute, ...overrides });
    },
    get app() { return calls.find(call => call.program === "/usr/bin/open")?.args[3]; },
    get source() {
      const compiler = calls.find(call => call.program === "/usr/bin/osacompile");
      assert.ok(compiler, "The macOS sender must be an extension-owned app, not bare osascript");
      return compiler.args[compiler.args.indexOf("-e") + 1];
    },
  };
}

unixTest("macOS creates and reuses a private, static helper without persisting notification content", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "keep.txt"), "Preserve unrelated artifacts");
  await f.notify();
  assert.ok(f.app?.endsWith("/Unread Notifications.app"), "Delivery must target the owned notification app");
  assert.equal((await stat(join(f.app, ".."))).mode & 0o777, 0o700);
  assert.doesNotMatch(f.source, /example\/widgets|Synthetic title|never-run/);
  const plist = await readFile(join(f.app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /io\.github\.fletchto99\.copilot-notifications-canvas\.notifier/);
  assert.match(plist, /LSUIElement/);
  assert.match(plist, /CompilerMetadata/);
  const delivery = f.calls.find(call => call.program === "/usr/bin/open");
  assert.deepEqual(delivery.args, ["-g", "-W", "-a", f.app, "--args", "--github-notifications-alert", title, body, "none"]);
  await f.notify();
  assert.equal(f.calls.filter(call => call.program === "/usr/bin/osacompile").length, 1);
  assert.equal(await readFile(join(f.directory, "keep.txt"), "utf8"), "Preserve unrelated artifacts");
  assert.equal((await readdir(f.directory)).some(name => name.startsWith(".macos-helper-")), false);
});

unixTest("only helper click activation opens Copilot, falling back to the fixed GitHub inbox", async t => {
  const f = await fixture(t);
  await f.notify();
  assert.match(f.source, /function reopen/);
  assert.match(f.source, /NSProcessInfo/);
  assert.match(f.source, /displayNotification/);
  const match = f.source.match(/doShellScript\("([^"]+)"\)/);
  assert.ok(match, "The click handler must have an explicit application/browser route");
  assert.equal(match[1], "/usr/bin/open -b com.github.githubapp || /usr/bin/open https://github.com/notifications");
  const opener = join(f.directory, "open.mjs");
  const output = join(f.directory, "opened.jsonl");
  await writeFile(opener, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(process.argv[2] === "-b" ? Number(process.env.COPILOT_FAIL) : 0);
`);
  const command = match[1].replaceAll("/usr/bin/open", `'${process.execPath}' '${opener}'`);
  for (const fails of [false, true]) {
    await writeFile(output, "");
    await run("/bin/sh", ["-c", command], {
      env: { ...process.env, OUTPUT: output, COPILOT_FAIL: fails ? "1" : "0" },
    });
    const opened = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(opened, fails
      ? [["-b", "com.github.githubapp"], ["https://github.com/notifications"]]
      : [["-b", "com.github.githubapp"]]);
  }
});

unixTest("helper compilation and signing errors are sanitized and never fall back to bare osascript", async t => {
  for (const program of ["/usr/bin/osacompile", "/usr/bin/plutil", "/usr/bin/codesign"]) {
    const f = await fixture(t);
    f.fail(program);
    await assert.rejects(f.notify(), error => error.code === "desktop_helper" &&
      !error.message.includes("Private subprocess") && error.message.includes("macOS"));
    assert.equal(f.calls.some(call => call.program === "/usr/bin/open"), false);
    assert.equal((await readdir(f.directory)).some(name => name.startsWith(".macos-helper-")), false);
  }
});

unixTest("modified helper code, missing receipts and symlinked artifacts are refused without replacement", async t => {
  for (const kind of ["modified", "receipt", "missing", "symlink"]) {
    const f = await fixture(t);
    if (kind === "symlink") {
      const linked = join(f.directory, "linked");
      await symlink(f.directory, linked, "dir");
      await assert.rejects(f.notify({ directory: linked }), { code: "desktop_helper" });
      assert.equal(f.calls.length, 0);
    } else {
      await f.notify();
      assert.ok(f.app?.endsWith("/Unread Notifications.app"), "The helper must exist before integrity can be checked");
      const file = kind === "modified"
        ? join(f.app, "Contents", "Resources", "Scripts", "main.scpt")
        : join(f.app, "..", "receipt.json");
      if (kind === "missing") await rm(file);
      else await writeFile(file, "Do not replace this modified file");
      const count = f.calls.length;
      await assert.rejects(f.notify(), { code: "desktop_helper" });
      assert.equal(f.calls.slice(count).some(call => call.program === "/usr/bin/open"), false);
      if (kind === "missing") await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
      else assert.equal(await readFile(file, "utf8"), "Do not replace this modified file");
    }
  }
});

unixTest("aborted helper preparation does not compile, launch, or deliver anything", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.notify({ signal: controller.signal }), { code: "closed" });
  assert.deepEqual(f.calls, []);
});

test("built-in macOS tools compile and validate the real helper without launching it or sending alerts",
  { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t);
    let delivered = false;
    await f.notify({ execute: (program, args, options, done) => {
      if (program === "/usr/bin/open") {
        delivered = true;
        assert.ok(args[3].endsWith("/Unread Notifications.app"));
        return done(null, "", "");
      }
      assert.ok(["/usr/bin/osacompile", "/usr/bin/plutil", "/usr/bin/codesign"].includes(program));
      return execFile(program, args, options, done);
    } });
    assert.equal(delivered, true);
  });

test("the native helper reads argument data without invoking the click route",
  { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t);
    const received = join(f.directory, "received.json");
    const clicked = join(f.directory, "clicked.txt");
    let app;
    await f.notify({ execute: (program, args, options, done) => {
      if (program === "/usr/bin/osacompile") {
        const sourceIndex = args.indexOf("-e") + 1;
        args = [...args];
        // Exercise the real applet transport without notifications or opening user applications.
        args[sourceIndex] = args[sourceIndex]
          .replace(/app\.doShellScript\("[^"]+"\);/,
            `$.NSString.stringWithString("clicked").writeToFileAtomicallyEncodingError(${JSON.stringify(clicked)}, true, $.NSUTF8StringEncoding, null);`)
          .replace("app.displayNotification(args[index + 2], options);",
            `$.NSString.stringWithString(JSON.stringify([args[index + 1], args[index + 2], args[index + 3]])).writeToFileAtomicallyEncodingError(${JSON.stringify(received)}, true, $.NSUTF8StringEncoding, null);`);
      }
      if (program === "/usr/bin/open") app = args[3];
      return execFile(program, args, options, done);
    } });
    assert.equal((await readdir(f.directory)).includes("clicked.txt"), false);
    assert.equal((await readdir(f.directory)).includes("received.json"), true, "The native helper must receive the supplied alert data");
    assert.deepEqual(JSON.parse(await readFile(received, "utf8")), [title, body, "none"]);
    await run("/usr/bin/open", ["-g", "-W", "-a", app], { timeout: 10_000 });
    assert.equal(await readFile(clicked, "utf8"), "clicked");
  });

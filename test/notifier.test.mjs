import test from "node:test";
import assert from "node:assert/strict";
import { notifyDesktop, notificationScript, windowsScript, desktopCapabilities, validSound } from "../src/notifier.mjs";

const title = "example/widgets";
const body = 'Fix <widget> & "quotes"; $(do-not-run)\nUnicode: caf\u00e9';

// Model notify-send's GLib g_strcompress layer, including octal and unknown escapes.
function decodeNotifySendBody(value) {
  const escapes = { a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return value.replace(/\\([0-7]{1,3}|[\s\S])/g, (_, escape) =>
    /^[0-7]/.test(escape) ? String.fromCharCode(parseInt(escape, 8) & 255) : escapes[escape] ?? escape);
}

async function command(platform, sound = "none", overrides = {}) {
  let call;
  await notifyDesktop({ title, body, platform, sound, execute: (...args) => {
    call = args.slice(0, 3);
    args[3](null);
  }, ...overrides });
  assert.equal(call[2].timeout, 10_000);
  assert.equal(call[2].shell, undefined);
  return call;
}

test("macOS passes repository, untrusted title and selected sound as data, never script source", async () => {
  for (const sound of ["none", "Glass", "Ping", "Submarine", "default"]) {
    const [program, args] = await command("darwin", sound);
    assert.equal(program, "/usr/bin/osascript");
    assert.deepEqual(args, ["-e", notificationScript, title, body, sound === "default" ? "DefaultSoundName" : sound]);
    assert.equal(notificationScript.includes(body), false);
  }
});

test("Windows uses built-in PowerShell, text nodes and environment data without module installs or policy bypasses", async () => {
  for (const sound of ["none", "default", "Mail", "IM", "SMS", "Reminder"]) {
    const [program, args, options] = await command("win32", sound, { env: { SystemRoot: "D:\\Windows" } });
    assert.equal(program, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsScript]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.COPILOT_TOAST_TITLE, title);
    assert.equal(options.env.COPILOT_TOAST_BODY, body);
    assert.equal(options.env.COPILOT_TOAST_SOUND, sound === "default" ? "Default" : sound);
    assert.match(windowsScript, /CreateTextNode/);
    assert.match(windowsScript, /Get-StartApps/);
    assert.doesNotMatch(windowsScript, /Install-Module|ExecutionPolicy|New-ItemProperty/);
    assert.equal(windowsScript.includes(body), false);
  }
});

test("Linux sends sound or silence hints, escapes body markup and terminates option parsing", async () => {
  for (const sound of ["none", "default", "message-new-instant", "message-new-email", "complete"]) {
    const [program, args] = await command("linux", sound);
    assert.equal(program, "notify-send");
    assert.ok(args.includes(`--hint=boolean:suppress-sound:${sound === "none"}`));
    if (!["none", "default"].includes(sound)) assert.ok(args.includes(`--hint=string:sound-name:${sound}`));
    assert.deepEqual(args.slice(-3), ["--", title, 'Fix &lt;widget&gt; &amp; "quotes"; $(do-not-run)\nUnicode: caf\u00e9']);
  }
});

test("Linux octal escapes cannot become hyperlinks or image tags after notify-send decodes the body", async () => {
  for (const [payload, unsafeDecoded] of [
    [String.raw`\074a href="https://example.invalid/"\076Open GitHub\074/a\076`,
      '<a href="https://example.invalid/">Open GitHub</a>'],
    [String.raw`\74img src="file:///tmp/never-read.png"/\76`,
      '<img src="file:///tmp/never-read.png"/>'],
  ]) {
    assert.equal(decodeNotifySendBody(payload), unsafeDecoded, "unescaped input demonstrates the native decoding hazard");
    const [, args] = await command("linux", "none", { body: payload });
    assert.equal(decodeNotifySendBody(args.at(-1)), payload);
    assert.doesNotMatch(decodeNotifySendBody(args.at(-1)), /[<>]/);
  }
});

test("Linux preserves literal backslashes and XML escaping through native decoding", async () => {
  const cases = [
    [String.raw`C:\tmp\report\note.txt`, String.raw`C:\tmp\report\note.txt`],
    [String.raw`\a\b\f\n\r\t\v\033\000\777\q`, String.raw`\a\b\f\n\r\t\v\033\000\777\q`],
    [String.raw`\046lt;a\046gt;`, String.raw`\046lt;a\046gt;`],
    ["trailing\\", "trailing\\"],
    [String.raw`\\074a\\076`, String.raw`\\074a\\076`],
    [String.raw`\<a href="https://example.invalid/">link</a> &`, String.raw`\&lt;a href="https://example.invalid/"&gt;link&lt;/a&gt; &amp;`],
    [body, 'Fix &lt;widget&gt; &amp; "quotes"; $(do-not-run)\nUnicode: caf\u00e9'],
  ];
  for (const [payload, expected] of cases) {
    const [, args] = await command("linux", "none", { body: payload });
    assert.equal(decodeNotifySendBody(args.at(-1)), expected);
  }
});

test("Linux body escaping does not change AppleScript arguments or PowerShell environment text", async () => {
  const payload = String.raw`\074a href="https://example.invalid/"\076literal\074/a\076`;
  const [, macArgs] = await command("darwin", "none", { body: payload });
  const [, winArgs, winOptions] = await command("win32", "none", { body: payload });
  assert.deepEqual(macArgs, ["-e", notificationScript, title, payload, "none"]);
  assert.equal(winArgs.at(-1), windowsScript);
  assert.equal(winOptions.env.COPILOT_TOAST_BODY, payload);
});

test("unsupported platforms, sound names, invalid content and missing commands fail explicitly", async () => {
  await assert.rejects(command("freebsd"), { code: "desktop_unsupported" });
  for (const [platform, sound] of [["darwin", "Mail"], ["win32", "Glass"], ["linux", "../../sound"], ["darwin", '"do script"']]) {
    await assert.rejects(command(platform, sound), { code: "desktop_sound" });
  }
  await assert.rejects(notifyDesktop({ platform: "darwin" }), { code: "desktop_content" });
  for (const platform of ["darwin", "win32", "linux"]) {
    await assert.rejects(command(platform, "none", { execute: (...args) =>
      args[3](Object.assign(new Error("DO NOT LOG private content"), { code: "ENOENT" })) }),
    error => error.code === "desktop_delivery" && !error.message.includes("private") &&
      (platform !== "linux" || error.message.includes("notify-send is missing")));
  }
});

test("system payload limits truncate long Unicode titles safely and remove XML control characters", async () => {
  const [, args] = await command("darwin", "none", { body: "\u0000" + "\u{1f600}".repeat(600) });
  assert.equal(Array.from(args[3]).length, 500);
  assert.ok(args[3].endsWith("..."));
  assert.equal(args[3].includes("\u0000"), false);
  assert.equal(args[3].includes("\ufffd"), false);
});

test("the sound catalog is platform-specific and exposes silence without assuming theme support", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const capabilities = desktopCapabilities(platform);
    assert.equal(capabilities.supported, true);
    assert.ok(capabilities.sounds.every(option => validSound(option.value, platform)));
  }
  assert.equal(desktopCapabilities("freebsd").supported, false);
  assert.match(desktopCapabilities("linux").help, /may ignore/);
});

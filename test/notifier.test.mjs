import test from "node:test";
import assert from "node:assert/strict";
import { notifyDesktop, notificationScript, windowsScript, desktopCapabilities, validSound } from "../.github/extensions/github-notifications/notifier.mjs";

const title = "example/widgets";
const body = 'Fix <widget> & "quotes"; $(do-not-run)\nUnicode: caf\u00e9';

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

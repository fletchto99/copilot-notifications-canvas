import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { notifyDesktop, notificationScript, windowsSenderScript, windowsDeliveryScript, windowsScript, desktopCapabilities, validSound } from "../src/notifier.mjs";

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

test("macOS compiles the actual notification script without executing it or showing an alert", {
  skip: process.platform !== "darwin",
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "notification-applescript-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "notification.scpt");
  await promisify(execFile)("/usr/bin/osacompile", ["-o", output, "-e", notificationScript], { timeout: 10_000 });
  assert.ok((await stat(output)).size > 0);
  const { stdout } = await promisify(execFile)("/usr/bin/osadecompile", [output], { timeout: 10_000 });
  assert.match(stdout, /on run argv/);
  assert.match(stdout, /display notification/);
  assert.match(stdout, /sound name/);
});

test("Windows uses built-in PowerShell, text nodes and environment data without module installs or policy bypasses", async () => {
  for (const sound of ["none", "default", "Mail", "IM", "SMS", "Reminder"]) {
    const [program, args, options] = await command("win32", sound, { env: { SystemRoot: "D:\\Windows" } });
    assert.equal(program, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsScript]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.COPILOT_TOAST_TITLE, title);
    assert.equal(options.env.COPILOT_TOAST_BODY, body);
    assert.equal(options.env.COPILOT_TOAST_URL, "");
    assert.equal(options.env.COPILOT_TOAST_SOUND, sound === "default" ? "Default" : sound);
    assert.match(windowsScript, /CreateTextNode/);
    assert.match(windowsScript, /Get-StartApps/);
    assert.doesNotMatch(windowsScript, /Install-Module|ExecutionPolicy|New-ItemProperty/);
    assert.equal(windowsScript.includes(body), false);
  }
});

test("Windows passes validated GitHub click targets as data without opening a browser on delivery", async () => {
  for (const url of [
    "https://github.com/example/widgets/issues/7",
    "https://github.com/example/widgets/pull/42",
    "https://github.com/example/widgets/actions/runs/123",
    "https://github.com/example/widgets/actions/runs/123/attempts/2",
    "https://github.com/example/widgets/actions/runs/123/job/456",
    "https://github.com/example/widgets/actions?query=workflow%3A%22Build%22+branch%3A%22main%22+is%3Afailure",
    "https://github.com/notifications?query=repo%3Aexample%2Fwidgets",
  ]) {
    const [, args, options] = await command("win32", "default", { url });
    assert.equal(options.env.COPILOT_TOAST_URL, url);
    assert.equal(args.includes(url), false);
    assert.equal(windowsScript.includes(url), false);
  }
  assert.match(windowsScript, /SetAttribute\('activationType', 'protocol'\)/);
  assert.match(windowsScript, /SetAttribute\('launch', \$env:COPILOT_TOAST_URL\)/);
  assert.doesNotMatch(windowsScript, /Start-Process|Invoke-Expression|Register-ObjectEvent/);
  const [, , options] = await command("win32", "none", { env: { COPILOT_TOAST_URL: "https://untrusted.invalid/" } });
  assert.equal(options.env.COPILOT_TOAST_URL, "", "inherited launch URLs must not affect alerts without a target");
});

test("unsafe desktop destinations fail explicitly before executing a subprocess", async () => {
  for (const url of [null, 42, {}, "", "https://github.com", "/example/widgets/issues/7",
    "http://github.com/example/widgets/issues/7", "javascript:alert(1)", "file:///C:/Windows/notepad.exe",
    "powershell:do-not-run", "https://api.github.com/repos/example/widgets/issues/7",
    "https://github.com.untrusted.invalid/example/widgets/issues/7", "https://github.com@untrusted.invalid/",
    "https://user:password@github.com/example/widgets/issues/7", "https://github.com:444/example/widgets/issues/7",
    "https://github.com\\@untrusted.invalid/", " https://github.com/example/widgets/issues/7",
    "https://github.com/example/widgets/issues/7\n", "https://github.com/example/widgets/\u0000",
  ]) {
    let executed = false;
    await assert.rejects(command("win32", "none", { url, execute: () => { executed = true; } }),
      error => error.code === "desktop_url" && error.status === 400 &&
        !error.message.includes("untrusted") && !error.message.includes("password"));
    assert.equal(executed, false);
  }
});

test("Windows toast XML round-trips protocol destinations and text without sending or launching anything", {
  skip: process.platform !== "win32",
}, async () => {
  const script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + windowsScript.replace(windowsSenderScript, "")
    .replace(/^\$notifier = .*CreateToastNotifier.*$/m, "")
    .replace(windowsDeliveryScript, `
$roundtrip = New-Object Windows.Data.Xml.Dom.XmlDocument
$roundtrip.LoadXml($xml.GetXml())
$root = $roundtrip.DocumentElement
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{
  activation = $root.GetAttribute('activationType')
  launch = $root.GetAttribute('launch')
  title = $roundtrip.GetElementsByTagName('text').Item(0).InnerText
  body = $roundtrip.GetElementsByTagName('text').Item(1).InnerText
  textCount = $roundtrip.GetElementsByTagName('text').Count
  silent = $roundtrip.GetElementsByTagName('audio').Item(0).GetAttribute('silent')
}))
`);
  assert.doesNotMatch(script, /CreateToastNotifier|\.Show\(|Get-StartApps/);
  const query = new URLSearchParams({ query: 'workflow:"Build & test" branch:"main" is:failure', extra: '"><actions/>' });
  for (const url of [undefined, "https://github.com/example/widgets/pull/42",
    `https://github.com/example/widgets/actions?${query}`]) {
    const [program, args, options] = await command("win32", "none", { url });
    const { stdout } = await promisify(execFile)(program, [...args.slice(0, -1), script], options);
    assert.deepEqual(JSON.parse(stdout), {
      activation: url ? "protocol" : "", launch: url ?? "", title, body, textCount: 2, silent: "true",
    });
  }
});

test("adding a destination does not change macOS or Linux delivery commands", async () => {
  const url = "https://github.com/example/widgets/issues/7";
  for (const platform of ["darwin", "linux"]) {
    const [program, args] = await command(platform);
    const [linkedProgram, linkedArgs, options] = await command(platform, "none", { url });
    assert.equal(linkedProgram, program);
    assert.deepEqual(linkedArgs, args);
    assert.equal(options.env, undefined);
  }
});

test("Windows resolves existing sender IDs without sending alerts or relying on display names", {
  skip: process.platform !== "win32",
}, async t => {
  const program = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const execute = promisify(execFile);
  const { stdout: home } = await execute(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Write($PSHOME)"],
    { timeout: 10_000, windowsHide: true });
  const named = "Microsoft.Windows.PowerShell";
  const systemPath = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
  const executable = win32.join(home, "powershell.exe");
  const app = (AppID, Name = "Localized sender name") => ({ AppID, Name });
  const cases = [
    { name: "named registration", apps: [app(named)], expected: named },
    { name: "System32 known-folder registration", apps: [app(systemPath)], expected: systemPath },
    { name: "absolute executable registration", apps: [app(executable)], expected: executable },
    { name: "case-insensitive IDs", apps: [app(systemPath.toUpperCase())], expected: systemPath.toUpperCase() },
    { name: "stable preference independent of Start menu order", apps: [app(executable), app(systemPath), app(named)], expected: named },
    { name: "ignores matching display names", apps: [app("unrelated.sender", "Windows PowerShell"), app(systemPath)], expected: systemPath },
    { name: "missing registration", apps: [] },
    { name: "unrelated hosts are not senders", apps: [
      app("Microsoft.AutoGenerated.{11111111-2222-3333-4444-555555555555}", "PowerShell 7 (x64)"),
      app(systemPath.replace("powershell.exe", "PowerShell_ISE.exe"), "Windows PowerShell ISE"),
      app("unrelated.sender", "Windows PowerShell"),
    ] },
  ];
  assert.ok(windowsScript.includes(windowsSenderScript));
  assert.doesNotMatch(windowsSenderScript, /ToastNotification|\.Show\(/);
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const result = execute(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
function Get-StartApps {
  $items = $env:COPILOT_TEST_START_APPS | ConvertFrom-Json
  $items
}
${windowsSenderScript}
[Console]::Write($app.AppID)
`], { timeout: 10_000, windowsHide: true, env: { ...process.env, COPILOT_TEST_START_APPS: JSON.stringify(fixture.apps) } });
      if (fixture.expected) {
        assert.equal((await result).stdout, fixture.expected);
      } else {
        await assert.rejects(result, error => error.code !== 0 &&
          error.stderr.includes("Windows PowerShell is not registered in the Start menu."));
      }
    });
  }
});

test("Windows permits a first toast without a settings profile but preserves disabled states and native errors", {
  skip: process.platform !== "win32",
}, async () => {
  const program = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assert.ok(windowsScript.includes(windowsDeliveryScript));
  assert.doesNotMatch(windowsDeliveryScript, /Windows\.UI|CreateToastNotifier/);
  const { stdout } = await promisify(execFile)(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
public class SyntheticNotifier {
  public string State;
  public int Sends;
  public string Setting {
    get {
      if (State == "MissingProfile")
        throw new System.Runtime.InteropServices.COMException("Synthetic missing profile", unchecked((int)0x80070490));
      if (State == "UnexpectedError")
        throw new System.Runtime.InteropServices.COMException("Synthetic unexpected error", unchecked((int)0x80070005));
      return State == "DeliveryError" ? "Enabled" : State;
    }
  }
  public void Show(object toast) {
    Sends++;
    if (State == "DeliveryError") throw new System.InvalidOperationException("Synthetic delivery error");
  }
}
'@
$results = foreach ($state in @('Enabled', 'MissingProfile', 'DisabledForApplication', 'DisabledForUser',
    'DisabledByGroupPolicy', 'DisabledByManifest', 'UnexpectedError', 'DeliveryError')) {
  $notifier = New-Object SyntheticNotifier
  $notifier.State = $state
  $toast = 'Synthetic toast'
  try {
    & { ${windowsDeliveryScript} }
    $outcome = 'sent'
  } catch {
    $outcome = 'error'
  }
  [pscustomobject]@{ state = $state; outcome = $outcome; sends = $notifier.Sends }
}
ConvertTo-Json -Compress -InputObject @($results)
`], { timeout: 10_000, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), [
    { state: "Enabled", outcome: "sent", sends: 1 },
    { state: "MissingProfile", outcome: "sent", sends: 1 },
    { state: "DisabledForApplication", outcome: "error", sends: 0 },
    { state: "DisabledForUser", outcome: "error", sends: 0 },
    { state: "DisabledByGroupPolicy", outcome: "error", sends: 0 },
    { state: "DisabledByManifest", outcome: "error", sends: 0 },
    { state: "UnexpectedError", outcome: "error", sends: 0 },
    { state: "DeliveryError", outcome: "error", sends: 1 },
  ]);
});

test("Windows reports only a fixed failure stage and HRESULT from native exceptions", {
  skip: process.platform !== "win32",
}, async () => {
  const program = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = windowsScript.replace(windowsSenderScript,
    "throw [System.Runtime.InteropServices.COMException]::new('DO NOT LOG private content', -2147024891)\n");
  await assert.rejects(promisify(execFile)(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 10_000, windowsHide: true }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /^COPILOT_TOAST_ERROR:sender:0x80070005\r?\n$/);
    assert.equal(error.stderr, "");
    return true;
  });
});

test("Windows delivery errors expose allowlisted diagnostics without raw subprocess output", async () => {
  for (const [stage, label] of Object.entries({
    sender: "PowerShell sender lookup", setup: "toast setup", permission: "permission check", delivery: "toast delivery",
  })) {
    await assert.rejects(command("win32", "none", { execute: (...args) =>
      args[3](new Error("DO NOT LOG private content"), `COPILOT_TOAST_ERROR:${stage}:0x80070490\r\n`, body) }),
    error => error.code === "desktop_delivery" &&
      error.message.includes(`Failed during ${label} (HRESULT 0x80070490).`) &&
      error.message.endsWith("This alert will not be retried.") &&
      !error.message.includes("private") && !error.message.includes(body));
  }
  for (const output of [undefined, body, "COPILOT_TOAST_ERROR:private:0x80070490",
    "COPILOT_TOAST_ERROR:delivery:private", "COPILOT_TOAST_ERROR:delivery:0x80070490\nprivate",
    `private\nCOPILOT_TOAST_ERROR:delivery:0x80070490`, "COPILOT_TOAST_ERROR:delivery:0x80070490\n\n"]) {
    await assert.rejects(command("win32", "none", { execute: (...args) =>
      args[3](new Error("DO NOT LOG private content"), output, body) }),
    error => error.code === "desktop_delivery" && !error.message.includes("HRESULT") &&
      !error.message.includes("private") && !error.message.includes(body));
  }
  for (const [failure, expected] of [
    [{ code: "ENOENT" }, "Built-in Windows PowerShell was not found."],
    [{ killed: true }, "Windows PowerShell did not complete within 10 seconds."],
  ]) {
    await assert.rejects(command("win32", "none", { execute: (...args) => args[3](failure) }),
      error => error.code === "desktop_delivery" && error.message.includes(expected));
  }
});

test("Linux sends sound or silence hints, escapes body markup and terminates option parsing", async () => {
  for (const sound of ["none", "default", "message-new-instant", "message-new-email", "complete"]) {
    const [program, args] = await command("linux", sound);
    assert.equal(program, "notify-send");
    assert.equal(args[0], "--app-name=GitHub Notifications");
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
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const sound of [true, false, null]) {
      await assert.rejects(command(platform, sound), { code: "desktop_sound" });
    }
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

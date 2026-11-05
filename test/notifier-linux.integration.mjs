import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { notifyDesktop } from "../src/notifier.mjs";

async function checkPrivateBus() {
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "dbus-run-session must provide a private bus");
  const daemon = spawn("/usr/bin/python3", [fileURLToPath(new URL("./notification-daemon.py", import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  daemon.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    daemon.once("error", error => resolve({ error }));
    daemon.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const reader = createInterface({ input: daemon.stdout });
  const lines = reader[Symbol.asyncIterator]();
  async function nextRecord() {
    let timer;
    try {
      const line = await Promise.race([
        lines.next(),
        exited.then(result => { throw result.error ?? new Error(`Synthetic daemon exited: ${result.code}, ${result.signal}. ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic daemon did not respond")), 5000); }),
      ]);
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    // The exclusive name must be owned by our fake before invoking real notify-send.
    assert.deepEqual(await nextRecord(), { ready: true });
    const body = 'Fix <widget> & "quotes"; $(do-not-run)\nUnicode: caf\u00e9';
    for (const [sound, text, expectedBody] of [
      ["none", body, 'Fix &lt;widget&gt; &amp; "quotes"; $(do-not-run)\nUnicode: caf\u00e9'],
      ["default", String.raw`\074img src="file:///tmp/never-read"/\076`, String.raw`\074img src="file:///tmp/never-read"/\076`],
      ["message-new-email", "Synthetic email", "Synthetic email"],
    ]) {
      await notifyDesktop({
        title: "--synthetic <repository>", body: text, sound,
        url: "https://github.com/example/widgets/issues/7",
      });
      const { icon, imagePath, ...record } = await nextRecord();
      assert.equal(imagePath ?? icon, "dialog-information", "libnotify may use the image-path hint instead of app_icon");
      assert.deepEqual(record, {
        app: "GitHub Notifications",
        summary: "--synthetic <repository>", body: expectedBody, actions: [],
        suppressSound: sound === "none",
        soundName: sound === "message-new-email" ? sound : null,
      });
    }
    assert.equal(stderr, "");
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    await exited;
    reader.close();
  }
}

if (process.argv.includes("--private-bus")) {
  await checkPrivateBus();
  process.stdout.write("Isolated native notification checks passed.\n");
} else {
  test("Linux notify-send sends the expected payload to an isolated fake notification service", {
    skip: process.platform !== "linux", timeout: 30_000,
  }, async () => {
    const env = { ...process.env };
    for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "DISPLAY", "WAYLAND_DISPLAY"]) {
      delete env[key];
    }
    const { stdout } = await promisify(execFile)("dbus-run-session",
      ["--", process.execPath, fileURLToPath(import.meta.url), "--private-bus"],
      { env, timeout: 25_000, maxBuffer: 64 * 1024, encoding: "utf8" });
    assert.equal(stdout.trim(), "Isolated native notification checks passed.");
  });
}

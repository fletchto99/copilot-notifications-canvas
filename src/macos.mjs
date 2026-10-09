import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { acquireLock } from "./lock.mjs";
import { InboxError } from "./model.mjs";

const identifier = "io.github.fletchto99.copilot-notifications-canvas.notifier";
const appName = "Unread Notifications.app";
const helperScript = `ObjC.import("Foundation");

function openDestination() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.doShellScript("/usr/bin/open -b com.github.githubapp || /usr/bin/open https://github.com/notifications");
}

function run() {
  const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments);
  const index = args.indexOf("--github-notifications-alert");
  if (index === -1) {
    openDestination();
    return;
  }
  if (args.length - index !== 4) throw new Error("Unexpected notification arguments.");
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const options = { withTitle: args[index + 1] };
  if (args[index + 3] !== "none") options.soundName = args[index + 3];
  app.displayNotification(args[index + 2], options);
}

function reopen() {
  openDestination();
}
`;

const bundleInfo = {
  CFBundleIdentifier: identifier,
  CFBundleName: "Unread Notifications",
  CFBundleDisplayName: "Unread Notifications",
  CFBundleShortVersionString: "1.0",
  CFBundleVersion: "1",
  OSAAppletShowStartupScreen: false,
  LSUIElement: true,
};

const digest = content => createHash("sha256").update(content).digest("hex");
const source = digest(`${helperScript}\n${JSON.stringify(bundleInfo)}`);
const helperMessage = "macOS notification helper could not be created or verified. Check artifact permissions and the built-in osacompile, plutil and codesign tools. Preserve modified macos-notifier entries for inspection; they were not replaced. This alert will not be retried.";
const stopped = () => new InboxError("closed", "Desktop notification watching stopped.", 410);

function checkSignal(signal) {
  if (signal?.aborted) throw stopped();
}

async function owned(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) {
    throw new Error("Unrecognized helper artifact");
  }
  return info;
}

async function read(path, limit) {
  await owned(path, false);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await file.stat()).size > limit) throw new Error("Helper artifact size limit");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function hashes(directory, relative = "", files = {}) {
  await owned(directory, true);
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const key = relative ? `${relative}/${name}` : name;
    const info = await lstat(path);
    if (info.isDirectory()) {
      await hashes(path, key, files);
    } else {
      if (Object.keys(files).length >= 128) throw new Error("Helper file count limit");
      files[key] = digest(await read(path, 8 * 1024 * 1024));
    }
  }
  return files;
}

function executeTool(execute, program, args, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    execute(program, args, { signal, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8", windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function verify(directory, execute, signal) {
  await owned(directory, true);
  const receipt = JSON.parse((await read(join(directory, "receipt.json"), 65_536)).toString("utf8"));
  const app = join(directory, appName);
  const files = await hashes(app);
  if (receipt?.format !== 1 || receipt.source !== source ||
      !receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files) ||
      Object.keys(receipt.files).length !== Object.keys(files).length ||
      Object.entries(files).some(([path, hash]) => receipt.files[path] !== hash) ||
      !["Contents/MacOS/applet", "Contents/Resources/Scripts/main.scpt", "Contents/Info.plist"].every(path => files[path])) {
    throw new Error("Modified or malformed helper");
  }
  await executeTool(execute, "/usr/bin/codesign", ["--verify", "--strict", app], signal);
  checkSignal(signal);
  return app;
}

export async function prepareMacOSHelper({ directory, execute, signal }) {
  try {
    checkSignal(signal);
    if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("Helper directory unavailable");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await owned(directory, true);
    const destination = join(directory, `macos-notifier-${source}`);
    if (await exists(destination)) return await verify(destination, execute, signal);
    let release;
    let temporary;
    try {
      release = await acquireLock(join(directory, ".macos-notifier.lock"), { label: "macOS notification helper" });
      if (!release) {
        throw new InboxError("desktop_helper", "Another canvas is creating the macOS notification helper. This alert will not be retried.", 503);
      }
      if (await exists(destination)) return await verify(destination, execute, signal);
      checkSignal(signal);
      temporary = await mkdtemp(join(directory, ".macos-helper-"));
      const app = join(temporary, appName);
      await executeTool(execute, "/usr/bin/osacompile", ["-l", "JavaScript", "-o", app, "-e", helperScript], signal);
      await hashes(app);
      const infoPath = join(app, "Contents", "Info.plist");
      const compiledInfo = JSON.parse(await executeTool(execute, "/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath], signal));
      if (!compiledInfo || typeof compiledInfo !== "object" || Array.isArray(compiledInfo)) throw new Error("Invalid applet metadata");
      await writeFile(infoPath, JSON.stringify({ ...compiledInfo, ...bundleInfo }));
      await executeTool(execute, "/usr/bin/plutil", ["-convert", "xml1", infoPath], signal);
      await executeTool(execute, "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, app], signal);
      const files = await hashes(app);
      await writeFile(join(temporary, "receipt.json"), `${JSON.stringify({ format: 1, source, files })}\n`, { flag: "wx", mode: 0o600 });
      await verify(temporary, execute, signal);
      if (await exists(destination)) throw new Error("Helper destination changed");
      await rename(temporary, destination);
      temporary = undefined;
      return join(destination, appName);
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        await release?.();
      }
    }
  } catch (error) {
    if (signal?.aborted) throw stopped();
    if (error instanceof InboxError) throw error;
    throw new InboxError("desktop_helper", helperMessage, 503);
  }
}

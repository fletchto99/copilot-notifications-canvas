import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./model.mjs";
import { validSound } from "./notifier.mjs";
import { acquireLock } from "./lock.mjs";

const MAX_SETTINGS_BYTES = 16_384;
const booleanValue = value => typeof value === "boolean";
const settingValidators = {
  autoOpen: booleanValue,
  desktopNotifications: booleanValue,
  darkMode: value => value === null || booleanValue(value),
  desktopSound: validSound,
  groupBy: value => ["none", "repo", "date"].includes(value),
};
const settingsValue = data => ({
  autoOpen: data.autoOpen ?? false,
  desktopNotifications: data.desktopNotifications ?? false,
  darkMode: data.darkMode ?? null,
  desktopSound: data.desktopSound ?? "default",
  groupBy: data.groupBy ?? "repo",
});

export class Preferences {
  constructor({ directory = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    "extensions", "github-notifications", "artifacts"), io = fs } = {}) {
    this.directory = directory;
    this.path = join(directory, "settings.json");
    this.io = io;
  }

  async document() {
    let file;
    try {
      file = await this.io.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("Invalid settings file");
      const data = JSON.parse(await file.readFile("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          Object.entries(settingValidators).some(([key, valid]) => data[key] !== undefined && !valid(data[key])) ||
          (data.desktopGeneration !== undefined && typeof data.desktopGeneration !== "string")) {
        throw new Error("Invalid settings object");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new InboxError("settings_read", "Could not read notification settings. Check artifacts/settings.json; autoOpen and desktopNotifications must be booleans, darkMode must be a boolean or null, desktopSound must be a supported sound name, and groupBy must be none, repo, or date.", 500);
    } finally {
      await file?.close();
    }
  }

  async read() {
    const data = await this.document();
    return settingsValue(data);
  }

  async update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length === 0 ||
        Object.keys(input).some(key => !Object.hasOwn(settingValidators, key)) ||
        Object.entries(settingValidators).some(([key, valid]) => Object.hasOwn(input, key) && !valid(input[key]))) {
      throw new InboxError("invalid_settings", "Settings accept autoOpen and desktopNotifications booleans, darkMode as a boolean or null, desktopSound as a supported sound name, and groupBy set to none, repo, or date.", 400);
    }
    const lockPath = join(this.directory, ".settings.lock");
    const temporary = join(this.directory, `.settings-${randomUUID()}.tmp`);
    let release;
    let temporaryCreated = false;
    try {
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const stat = await this.io.lstat(lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new InboxError("settings_busy", "A legacy or unrecognized settings lock exists. Wait for any settings save to finish. If it remains, stop all older extension processes before inspecting or removing artifacts/.settings.lock.", 409);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      release = await acquireLock(lockPath, { label: "settings" });
      if (!release) throw new InboxError("settings_busy", "Notification settings are being updated. Retry shortly.", 409);
      const current = await this.document();
      const updated = { ...current, ...input };
      if (input.desktopNotifications === true && !current.desktopNotifications) {
        updated.desktopGeneration = randomUUID();
      }
      const content = `${JSON.stringify(updated, null, 2)}\n`;
      if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES) throw new Error("Settings size limit");
      const output = await this.io.open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await output.writeFile(content);
      } finally {
        await output.close();
      }
      await this.io.rename(temporary, this.path);
      temporaryCreated = false;
      return settingsValue(updated);
    } catch (error) {
      if (error instanceof InboxError) throw error;
      throw new InboxError("settings_write", "Could not save notification settings. Check permissions, free disk space and unrecognized .settings.lock contents in the extension artifacts directory.", 500);
    } finally {
      try {
        try {
          if (temporaryCreated) await this.io.unlink(temporary);
        } finally {
          await release?.();
        }
      } catch {
        // eslint-disable-next-line no-unsafe-finally -- Cleanup failures must surface even when the update also failed.
        throw new InboxError("settings_cleanup", "Settings cleanup failed. Check the extension artifacts directory before retrying.", 500);
      }
    }
  }
}

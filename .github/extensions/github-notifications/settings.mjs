import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./model.mjs";

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
      if (!stat.isFile() || stat.size > 16_384) throw new Error("Invalid settings file");
      const data = JSON.parse(await file.readFile("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          (data.autoOpen !== undefined && typeof data.autoOpen !== "boolean")) {
        throw new Error("Invalid settings object");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new InboxError("settings_read", "Could not read notification settings. Check artifacts/settings.json; it must be a valid JSON object with a boolean autoOpen setting.", 500);
    } finally {
      await file?.close();
    }
  }

  async read() {
    const data = await this.document();
    return { autoOpen: data.autoOpen ?? false };
  }

  async update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.autoOpen !== "boolean") {
      throw new InboxError("invalid_settings", "Settings require only an autoOpen boolean.", 400);
    }
    const lockPath = join(this.directory, ".settings.lock");
    const temporary = join(this.directory, `.settings-${randomUUID()}.tmp`);
    let lock;
    let temporaryCreated = false;
    try {
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        lock = await this.io.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new InboxError("settings_busy", "Notification settings are being updated. Retry shortly; a lock left after a crash may need manual removal.", 409);
        }
        throw error;
      }
      const current = await this.document();
      const content = JSON.stringify({ ...current, autoOpen: input.autoOpen }, null, 2);
      if (Buffer.byteLength(content) > 16_384) throw new Error("Settings size limit");
      const output = await this.io.open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await output.writeFile(`${content}\n`);
      } finally {
        await output.close();
      }
      await this.io.rename(temporary, this.path);
      temporaryCreated = false;
      return { autoOpen: input.autoOpen };
    } catch (error) {
      if (error instanceof InboxError) throw error;
      throw new InboxError("settings_write", "Could not save notification settings. Check permissions and free disk space in the extension artifacts directory.", 500);
    } finally {
      try {
        if (temporaryCreated) await this.io.unlink(temporary);
        if (lock) {
          await lock.close();
          await this.io.unlink(lockPath);
        }
      } catch {
        throw new InboxError("settings_cleanup", "Settings cleanup failed. Check the extension artifacts directory before retrying.", 500);
      }
    }
  }
}

import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiTarget, InboxError, sharedFilters, validFilterChanges, validFilterDefaults } from "../shared/model.mjs";
import { validSound } from "./notifier.mjs";
import { acquireLock } from "./lock.mjs";

const MAX_SETTINGS_BYTES = 16_384;
const booleanValue = value => typeof value === "boolean";
const validUpdatedAt = value => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const settingValidators = {
  // Retained for older providers and the initial panel read-state filter.
  matchGitHubInbox: booleanValue,
  filterDefaults: validFilterDefaults,
  autoOpen: booleanValue,
  desktopNotifications: booleanValue,
  terminalNotifierHintDismissed: booleanValue,
  darkMode: value => value === null || booleanValue(value),
  desktopSound: validSound,
  groupBy: value => ["none", "repo", "date"].includes(value),
  copilotIntegration: booleanValue,
  confirmCopilotActions: booleanValue,
  hideEmptyTabs: booleanValue,
  keyboardShortcuts: booleanValue,
};
const settingsValue = data => ({
  revision: data.revision ?? 0,
  updatedAt: data.updatedAt ?? null,
  matchGitHubInbox: data.matchGitHubInbox ?? true,
  ...(data.filterDefaults === undefined ? {} : { filterDefaults: { ...data.filterDefaults } }),
  autoOpen: data.autoOpen ?? false,
  desktopNotifications: data.desktopNotifications ?? false,
  terminalNotifierHintDismissed: data.terminalNotifierHintDismissed ?? false,
  darkMode: data.darkMode ?? null,
  desktopSound: data.desktopSound ?? "default",
  groupBy: data.groupBy ?? "repo",
  copilotIntegration: data.copilotIntegration ?? true,
  confirmCopilotActions: data.confirmCopilotActions ?? true,
  hideEmptyTabs: data.hideEmptyTabs ?? true,
  keyboardShortcuts: data.keyboardShortcuts ?? true,
});

export class Preferences {
  constructor({ directory = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    "extensions", "github-notifications", "artifacts"), io = fs, now = Date.now } = {}) {
    this.directory = directory;
    this.path = join(directory, "settings.json");
    this.io = io;
    this.now = now;
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
          (data.revision !== undefined && (!Number.isSafeInteger(data.revision) || data.revision < 0)) ||
          (data.updatedAt !== undefined && !validUpdatedAt(data.updatedAt)) ||
          (data.desktopGeneration !== undefined && typeof data.desktopGeneration !== "string")) {
        throw new Error("Invalid settings object");
      }
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new InboxError("settings_read", "Could not read notification settings. Check artifacts/settings.json; matchGitHubInbox, autoOpen, desktopNotifications, terminalNotifierHintDismissed, copilotIntegration, confirmCopilotActions, hideEmptyTabs and keyboardShortcuts must be booleans, darkMode must be a boolean or null, desktopSound must be a supported sound name, groupBy must be none, repo, or date, filterDefaults must contain only supported type, readState, reason and age values, revision must be a nonnegative safe integer, and updatedAt must be a UTC ISO timestamp.", 500);
    } finally {
      await file?.close();
    }
  }

  async read() {
    const data = await this.document();
    return settingsValue(data);
  }

  async readDevelopmentAPI() {
    const data = await this.document();
    try {
      return apiTarget(data.developmentApiBaseUrl).baseUrl;
    } catch {
      throw new InboxError("settings_read", "Could not read the development API. Check developmentApiBaseUrl in artifacts/settings.json; it must be an HTTPS REST API base URL with a DNS hostname or IPv4 address and no credentials, query parameters, or fragments.", 500);
    }
  }

  async updateDevelopmentAPI(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.baseUrl !== "string") {
      throw new InboxError("invalid_api", "Development API settings accept only a baseUrl string.", 400);
    }
    const { baseUrl } = apiTarget(input.baseUrl);
    await this.#write({ developmentApiBaseUrl: baseUrl });
  }

  async update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length === 0 ||
        Object.keys(input).some(key => !Object.hasOwn(settingValidators, key)) ||
        Object.entries(settingValidators).some(([key, valid]) => Object.hasOwn(input, key) && !valid(input[key]))) {
      throw new InboxError("invalid_settings", "Settings accept matchGitHubInbox, autoOpen, desktopNotifications, terminalNotifierHintDismissed, copilotIntegration, confirmCopilotActions, hideEmptyTabs and keyboardShortcuts booleans, darkMode as a boolean or null, desktopSound as a supported sound name, groupBy set to none, repo, or date, and filterDefaults containing only supported type, readState, reason and age values.", 400);
    }
    return settingsValue(await this.#write(input));
  }

  async updateFilters(input) {
    if (!validFilterChanges(input)) {
      throw new InboxError("invalid_filters", "Change only supported type, readState, reason and age choices.", 400);
    }
    return settingsValue(await this.#write(input, true));
  }

  async #write(input, mergeFilters = false) {
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
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new InboxError("settings_write", "The settings revision limit was reached. Inspect the settings file before saving again.", 500);
      }
      if (mergeFilters) input = { filterDefaults: { ...sharedFilters(current), ...input } };
      const updated = { ...current, ...input, revision: (current.revision ?? 0) + 1,
        updatedAt: new Date(this.now()).toISOString() };
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
      return updated;
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

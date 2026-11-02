import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "./lock.mjs";

export const STARTUP_INSTANCE = "unread-notifications-startup";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

export async function acquireStartupLock(workspacePath) {
  if (!workspacePath) throw new Error("Session workspace unavailable");
  const directory = join(workspacePath, "files");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return acquireLock(join(directory, ".github-notifications-startup.lock"), { label: "auto-open" });
}

function isNotificationsCanvas(canvas) {
  return canvas?.canvasId === "github-notifications";
}

function isDismissal(event) {
  return ["session.canvas.closed", "session.canvas.removed"].includes(event.type) &&
    isNotificationsCanvas(event.data);
}

export class Startup {
  constructor(session, preferences, { lock = acquireStartupLock, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.session = session;
    this.preferences = preferences;
    this.lock = lock;
    this.schedule = schedule;
    this.cancel = cancel;
    this.status = "initializing";
    this.stopped = false;
    this.started = false;
    this.failures = 0;
    this.opening = false;
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      this.unsubscribe = this.session.on(event => {
        if (isDismissal(event)) {
          this.finish("dismissed");
        } else if (["session.canvas.opened", "session.canvas.recorded"].includes(event.type) &&
            isNotificationsCanvas(event.data) &&
            !(this.opening && event.data.instanceId === STARTUP_INSTANCE)) {
          this.finish("panel-already-open");
        } else if (["user.message", "assistant.turn_start", "assistant.message"].includes(event.type)) {
          this.finish("session-already-active");
        } else if (event.type === "session.shutdown") {
          this.finish("stopped");
        } else if (event.type === "capabilities.changed" && this.status === "waiting-for-renderer") {
          void this.attempt();
        }
      });
      const { autoOpen } = await this.preferences.read();
      if (this.stopped) return;
      if (!autoOpen) return this.finish("disabled");
      await this.attempt();
    } catch {
      this.finish("error");
      await this.warn(false);
    }
  }

  attempt() {
    if (this.stopped || this.timer || this.pending) return this.pending;
    this.pending = this.check().finally(() => {
      this.pending = undefined;
      if (this.stopped || this.status !== "retrying") return;
      this.timer = this.schedule(() => {
        this.timer = undefined;
        void this.attempt();
      }, RETRY_DELAY_MS * this.failures);
      this.timer.unref?.();
    });
    return this.pending;
  }

  async check() {
    try {
      const { autoOpen } = await this.preferences.read();
      if (this.stopped) return;
      if (!autoOpen) return this.finish("disabled");
      if (this.session.capabilities.ui?.canvases !== true) {
        this.status = "waiting-for-renderer";
        return;
      }
      this.status = "opening";
      const status = await this.openOnce();
      if (this.stopped) return;
      if (status === "busy") await this.retry(false);
      else this.finish(status);
    } catch {
      await this.retry(true);
    }
  }

  async openOnce() {
    const release = await this.lock(this.session.workspacePath);
    if (!release) return "busy";
    try {
      if (this.stopped) return;
      // The runtime's durable canvas journal, not conversation activity, owns dismissal.
      if ((await this.session.getEvents()).some(isDismissal)) return "dismissed";
      if (this.stopped) return;
      const { openCanvases } = await this.session.rpc.canvas.listOpen();
      if (openCanvases.some(isNotificationsCanvas)) return "panel-already-open";
      if (this.stopped) return;
      const { canvases } = await this.session.rpc.canvas.list();
      const candidates = canvases.filter(isNotificationsCanvas);
      const provider = candidates.find(canvas => canvas.extensionId === "project:github-notifications") ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (this.stopped) return;
      if (!provider) throw new Error("Notifications canvas provider unavailable or ambiguous");
      const { openCanvases: currentPanels } = await this.session.rpc.canvas.listOpen();
      if (currentPanels.some(isNotificationsCanvas)) return "panel-already-open";
      if (this.stopped) return;
      this.opening = true;
      await this.session.rpc.canvas.open({
        extensionId: provider.extensionId,
        canvasId: "github-notifications",
        instanceId: STARTUP_INSTANCE,
        input: {},
      });
      return "opened";
    } finally {
      this.opening = false;
      await release();
    }
  }

  async retry(failed) {
    if (this.stopped) {
      if (failed) await this.warn(false);
      return;
    }
    if (++this.failures >= MAX_ATTEMPTS) {
      this.finish("error");
      await this.warn(false);
      return;
    }
    this.status = "retrying";
    if (failed) await this.warn(true);
  }

  finish(status) {
    this.status = status;
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
  }

  async warn(retrying) {
    await this.session.log(retrying
      ? "Unread Notifications could not auto-open. Retrying shortly."
      : "Unread Notifications could not complete auto-open. Check notification settings, the session workspace, and canvas availability; re-enter or reload the session to try again.",
    { level: "warning" });
  }

  async close() {
    this.finish("stopped");
    await this.pending;
  }
}

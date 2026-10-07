import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export const STARTUP_INSTANCE = "unread-notifications-startup";

export async function claimStartup(workspacePath) {
  if (!workspacePath) throw new Error("Session workspace unavailable");
  const directory = join(workspacePath, "files");
  await mkdir(directory, { recursive: true });
  let file;
  try {
    file = await open(join(directory, "github-notifications-startup.json"), "wx", 0o600);
    await file.writeFile('{"checked":true}\n');
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await file?.close();
  }
}

function isNotificationsCanvas(canvas) {
  return canvas.canvasId === "github-notifications";
}

function isNotificationsActivity(event) {
  return ["session.canvas.opened", "session.canvas.closed",
    "session.canvas.recorded", "session.canvas.removed"].includes(event.type) &&
    isNotificationsCanvas(event.data);
}

function freshSession(events) {
  return events.some(event => event.type === "session.start") &&
    !events.some(event => ["session.resume", "assistant.turn_start", "assistant.message"].includes(event.type) ||
      isNotificationsActivity(event));
}

export class Startup {
  constructor(session, preferences, { claim = claimStartup } = {}) {
    this.session = session;
    this.preferences = preferences;
    this.claim = claim;
    this.status = "initializing";
    this.stopped = false;
    this.attempted = false;
  }

  async start() {
    if (this.status !== "initializing") return;
    try {
      if (!await this.claim(this.session.workspacePath)) return this.finish("already-checked");
      if (!(await this.preferences.read()).autoOpen) return this.finish("disabled");
      this.unsubscribe = this.session.on(event => {
        if (event.type === "capabilities.changed" && this.status === "waiting-for-renderer") void this.attempt();
        if (["session.resume", "assistant.turn_start"].includes(event.type) ||
            (isNotificationsActivity(event) &&
             !(["session.canvas.opened", "session.canvas.recorded"].includes(event.type) &&
               event.data.instanceId === STARTUP_INSTANCE))) {
          this.finish("session-already-active");
        }
      });
      if (!freshSession(await this.session.getEvents())) return this.finish("existing-session");
      if (this.stopped) return;
      await this.attempt();
    } catch {
      await this.fail();
    }
  }

  async attempt() {
    if (this.stopped || this.attempted) return;
    if (this.session.capabilities.ui?.canvases !== true) {
      this.status = "waiting-for-renderer";
      return;
    }
    this.attempted = true;
    try {
      if (!(await this.preferences.read()).autoOpen) return this.finish("disabled");
      if (!freshSession(await this.session.getEvents())) return this.finish("existing-session");
      const { openCanvases } = await this.session.rpc.canvas.listOpen();
      if (openCanvases.some(isNotificationsCanvas)) return this.finish("panel-already-open");
      if (this.stopped) return;
      await this.session.rpc.canvas.open({
        canvasId: "github-notifications",
        instanceId: STARTUP_INSTANCE,
        input: {},
      });
      this.finish("opened");
    } catch {
      await this.fail();
    }
  }

  finish(status) {
    this.status = status;
    this.stopped = true;
    this.unsubscribe?.();
  }

  async fail() {
    this.finish("error");
    await this.session.log("Unread Notifications could not check or apply auto-open. Check notification settings, the session workspace, and canvas availability.", { level: "warning" });
  }

  close() {
    this.finish("stopped");
  }
}

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { GitHubClient } from "./github.mjs";
import { Inbox } from "./inbox.mjs";
import { emptySchema, filterSchema, InboxError } from "./model.mjs";
import { startServer } from "./server.mjs";
import { Preferences } from "./settings.mjs";
import { Startup } from "./startup.mjs";
import { DesktopNotifications } from "./desktop.mjs";

const instances = new Map();
const client = new GitHubClient();
const preferences = new Preferences();
let session;
let startup;
const log = (message, options) => session?.log(message, options);
const desktop = new DesktopNotifications({ preferences, log });

async function action(ctx, run) {
  try {
    const entry = await instances.get(ctx.instanceId);
    if (!entry) throw new InboxError("not_open", "Open the notifications canvas first.", 404);
    return await run(entry.inbox);
  } catch (error) {
    if (error instanceof InboxError) throw new CanvasError(error.code, error.message);
    log("Unexpected notifications action failure.", { level: "error" });
    throw new CanvasError("internal_error", "Unexpected inbox error. Inspect the extension log.");
  }
}

async function close(instanceId) {
  const pending = instances.get(instanceId);
  if (!pending) return;
  instances.delete(instanceId);
  await desktop.remove(instanceId);
  await (await pending).close();
  if (!instances.size) client.clear();
}

session = await joinSession({
  canvases: [createCanvas({
    id: "github-notifications",
    displayName: "Unread Notifications",
    description: "Unread GitHub notifications with one-click row and repository read actions limited to shown, loaded items.",
    inputSchema: filterSchema,
    actions: [
      {
        name: "get_settings",
        description: "Read startup and desktop notification settings and status. Settings are changed only by clicks in the panel.",
        inputSchema: emptySchema,
        handler: ctx => action(ctx, async () => ({
          ...await preferences.read(), desktopStatus: desktop.snapshot(), startupStatus: startup?.status ?? "initializing",
        })),
      },
      {
        name: "get_state",
        description: "Return counts, status and pagination metadata, never notification content or repository names.",
        inputSchema: emptySchema,
        handler: ctx => action(ctx, inbox => inbox.summary()),
      },
      {
        name: "refresh",
        description: "Refresh loaded pages, respecting GitHub polling and rate limits; return aggregate status.",
        inputSchema: emptySchema,
        handler: ctx => action(ctx, inbox => inbox.refresh()),
      },
      {
        name: "set_filters",
        description: "Search loaded unread notification titles and repositories; return aggregate status.",
        inputSchema: filterSchema,
        handler: ctx => action(ctx, inbox => inbox.setFilters(ctx.input)),
      },
      {
        name: "load_more",
        description: "Load the next page of up to 50 notifications; return aggregate status.",
        inputSchema: emptySchema,
        handler: ctx => action(ctx, inbox => inbox.more()),
      },
    ],
    open: async ctx => {
      let pending;
      try {
        if (!instances.has(ctx.instanceId)) {
          const inbox = new Inbox(client, ctx.input ?? {});
          instances.set(ctx.instanceId, startServer(inbox, { log, preferences, desktop }).catch(error => {
            inbox.close();
            throw error;
          }));
        }
        pending = instances.get(ctx.instanceId);
        const entry = await pending;
        if (instances.get(ctx.instanceId) !== pending) {
          throw new InboxError("closed", "The Notifications canvas was closed while opening.", 410);
        }
        desktop.add(ctx.instanceId);
        return { title: "Unread Notifications", url: entry.url };
      } catch (error) {
        if (instances.get(ctx.instanceId) === pending) instances.delete(ctx.instanceId);
        if (error instanceof InboxError) throw new CanvasError(error.code, error.message);
        log("Could not start the notifications loopback server.", { level: "error" });
        throw new CanvasError("server_start", "Could not start the local notifications server.");
      }
    },
    onClose: ctx => close(ctx.instanceId),
  })],
});
startup = new Startup(session, preferences);
await startup.start();

async function shutdown() {
  startup?.close();
  await desktop.close();
  await Promise.allSettled([...instances.keys()].map(close));
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("disconnect", shutdown);

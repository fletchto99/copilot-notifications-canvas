import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { InboxError } from "./model.mjs";
import { validSound } from "./notifier.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/model.mjs", ["model.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const batchRoutes = new Map([
  ["/api/batch/start", "start"],
  ["/api/batch/cancel", "cancel"],
  ["/api/batch/retry", "retry"],
  ["/api/batch/dismiss", "dismiss"],
]);

const recoveryHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unread Notifications</title>
  <style>
    body { margin: 0; padding: 24px; color: var(--text-color-default, #1f2328);
      background: var(--background-color-default, #fff);
      font: var(--text-body-medium, 14px)/1.5 var(--font-sans, system-ui, sans-serif); }
    h1 { font-size: 20px; }
    p { max-width: 48em; }
    a { color: var(--text-color-default, #1f2328); }
  </style>
  <script type="module" src="/startup.mjs"></script>
</head>
<body><main>
  <h1>Unread Notifications</h1>
  <p role="status">The canvas could not load its local files. Retrying in the background...</p>
  <p>Your notifications will appear here when loading succeeds. If this continues, reload
    extensions or reinstall the canvas without deleting its settings.</p>
  <p><a href="https://github.com/notifications" target="_blank" rel="noopener noreferrer">Open GitHub inbox</a></p>
</main></body>
</html>`;

const recoveryScript = `
const controller = new AbortController();
let timer;
window.addEventListener("pagehide", () => {
  clearTimeout(timer);
  controller.abort();
}, { once: true });
async function check() {
  try {
    const response = await fetch("/api/ready", {
      headers: { Authorization: "Bearer " + location.hash.slice(1) },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      credentials: "omit", cache: "no-store",
    });
    if (response.ok && (await response.json()).ready && !controller.signal.aborted) {
      location.reload();
      return;
    }
  } catch {
    // Keep the recovery message visible while the local server is unavailable.
  }
  if (!controller.signal.aborted) timer = setTimeout(check, 2000);
}
void check();
`;

function failureCode(error) {
  return ["ENOENT", "EACCES", "EPERM", "EIO", "EMFILE", "ENFILE", "EADDRINUSE", "EADDRNOTAVAIL", "ENOBUFS", "ENOMEM"]
    .includes(error?.code) ? ` (${error.code})` : "";
}

function assertOpen(signal) {
  if (signal.aborted) throw new InboxError("closed", "The Notifications canvas was closed while opening.", 410);
}

function authorized(value, secret) {
  const provided = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(req) {
  if (req.headers["content-type"] !== "application/json") {
    throw new InboxError("content_type", "Send application/json.", 415);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new InboxError("body_too_large", "Request body is too large.", 413);
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InboxError("invalid_json", "Send a valid JSON object.", 400);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InboxError("invalid_json", "Send a JSON object.", 400);
  }
  return input;
}

export async function startServer(inbox, { log = () => {}, preferences, desktop, updates, read = readFile } = {}) {
  const secret = randomBytes(32).toString("hex");
  const snapshot = () => ({ ...inbox.snapshot(), ...(updates ? { updates: updates.snapshot() } : {}) });
  const controller = new AbortController();
  const signal = AbortSignal.any([inbox.controller.signal, controller.signal]);
  let staticFiles;
  let retryTimer;
  let retryDelay = 1000;
  let assetFailureLogged = false;
  async function loadAssets() {
    try {
      const files = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
        [path, { body: await read(new URL(`./${file}`, import.meta.url), { signal }), type }])));
      if (!signal.aborted) staticFiles = files;
    } catch (error) {
      if (signal.aborted) return;
      if (!assetFailureLogged) {
        log(`Could not load the notifications canvas assets${failureCode(error)}. Retrying in the background.`, { level: "warning" });
        assetFailureLogged = true;
      }
      retryTimer = setTimeout(() => { void loadAssets(); }, retryDelay);
      retryTimer.unref();
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }
  const cancelRetry = () => clearTimeout(retryTimer);
  signal.addEventListener("abort", cancelRetry, { once: true });
  await loadAssets();
  assertOpen(signal);
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'");
    const json = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== new URL(origin).host) {
        throw new InboxError("invalid_host", "Invalid loopback host.", 403);
      }
      const path = req.url;
      if (assets.has(path) || path === "/startup.mjs") {
        if (req.method !== "GET") throw new InboxError("method", "Only GET is supported.", 405);
        const file = path === "/startup.mjs"
          ? { body: recoveryScript, type: "text/javascript; charset=utf-8" }
          : staticFiles?.get(path) ?? (path === "/" ? { body: recoveryHtml, type: "text/html; charset=utf-8" } : null);
        if (!file) throw new InboxError("server_initializing", "The canvas is still loading its local files. Retrying in the background.", 503);
        res.writeHead(200, { "Content-Type": file.type });
        res.end(file.body);
        return;
      }
      if (!["/api/ready", "/api/state", "/api/refresh", "/api/more", "/api/filters", "/api/settings", "/api/read", "/api/updates"].includes(path) &&
          !batchRoutes.has(path)) {
        throw new InboxError("not_found", "Route not found.", 404);
      }
      if (!authorized(req.headers.authorization, secret) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
        throw new InboxError("forbidden", "This request is not authorized for the canvas.", 403);
      }
      if (path === "/api/ready") {
        if (req.method !== "GET") throw new InboxError("method", "Only GET is supported.", 405);
        return json(200, { ready: Boolean(staticFiles) });
      }
      if (!staticFiles) throw new InboxError("server_initializing", "The canvas is still loading its local files. Retrying in the background.", 503);
      if (path === "/api/settings" && !preferences) {
        throw new InboxError("settings_unavailable", "Notification settings are unavailable.", 503);
      }
      if (path === "/api/state" || (path === "/api/settings" && req.method === "GET")) {
        if (req.method !== "GET") throw new InboxError("method", "Only GET is supported.", 405);
        if (path === "/api/settings") return json(200, {
          ...await preferences.read(), desktopStatus: desktop?.snapshot() ?? { supported: false, state: "off", message: "Desktop notifications are unavailable." },
        });
      } else {
        if (req.method !== "POST") throw new InboxError("method", "Only POST is supported.", 405);
        if (req.headers.origin !== origin) throw new InboxError("origin", "A same-origin request is required.", 403);
        const input = await readBody(req);
        if (!["/api/refresh", "/api/filters", "/api/settings", "/api/read"].includes(path) && !batchRoutes.has(path) && Object.keys(input).length) {
          throw new InboxError("invalid_input", "This action takes an empty object.", 400);
        }
        if (path === "/api/updates") {
          if (!updates) throw new InboxError("updates_unavailable", "Release checks are unavailable.", 503);
          void updates.check({ force: true });
          return json(202, updates.snapshot());
        }
        if (path === "/api/refresh") await inbox.refresh(input);
        if (path === "/api/more") await inbox.more();
        if (path === "/api/filters") await inbox.setFilters(input);
        if (path === "/api/settings") {
          if (input.desktopNotifications === true && !desktop?.supported) {
            throw new InboxError("desktop_unsupported", "Desktop notifications are supported on macOS, Windows and Linux.", 400);
          }
          if (Object.hasOwn(input, "desktopSound") && (!desktop?.supported || !validSound(input.desktopSound, desktop.platform))) {
            throw new InboxError("desktop_sound", "Choose a notification sound supported by this operating system.", 400);
          }
          const settings = await preferences.update(input);
          desktop?.wake(settings);
          return json(200, {
            ...settings, desktopStatus: desktop?.snapshot() ?? { supported: false, state: "off", message: "Desktop notifications are unavailable." },
          });
        }
        if (path === "/api/read") await inbox.markRead(input);
        if (batchRoutes.has(path)) {
          inbox.batch[batchRoutes.get(path)](input);
          return json(["/api/batch/start", "/api/batch/retry"].includes(path) ? 202 : 200, snapshot());
        }
      }
      if (path === "/api/state" || path === "/api/refresh") void updates?.check();
      json(200, snapshot());
    } catch (error) {
      if (error instanceof InboxError) {
        json(error.status, { error: { code: error.code, message: error.message } });
      } else {
        log("Unexpected notifications HTTP failure.", { level: "error" });
        json(500, { error: { code: "internal_error", message: "Unexpected canvas error. Inspect the extension log." } });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 35_000;
  server.maxHeadersCount = 40;
  try {
    for (let attempt = 0; ; attempt++) {
      assertOpen(signal);
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            server.removeListener("error", failed);
            server.removeListener("listening", listening);
          };
          const failed = error => { cleanup(); reject(error); };
          const listening = () => { cleanup(); resolve(); };
          server.once("error", failed);
          server.once("listening", listening);
          try {
            server.listen(0, "127.0.0.1");
          } catch (error) {
            failed(error);
          }
        });
        assertOpen(signal);
        break;
      } catch (error) {
        assertOpen(signal);
        if (attempt === 2) {
          throw new InboxError("server_start",
            `Could not start the local notifications server${failureCode(error)} after 3 attempts. Reload extensions to try again.`, 503);
        }
        if (attempt === 0) log(`Could not bind the notifications loopback server${failureCode(error)}. Retrying.`, { level: "warning" });
        await wait(250 * 2 ** attempt, undefined, { signal });
      }
    }
  } catch (error) {
    controller.abort();
    signal.removeEventListener("abort", cancelRetry);
    server.close();
    assertOpen(inbox.controller.signal);
    log(error.message, { level: "error" });
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    url: `${origin}/#${secret}`,
    inbox,
    async close() {
      if (closed) return;
      closed = true;
      inbox.close();
      signal.removeEventListener("abort", cancelRetry);
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await inbox.batch.done;
    },
  };
}

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { InboxError } from "./model.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/sound.mjs", ["sound.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

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

export async function startServer(inbox, { log = () => {}, preferences } = {}) {
  const secret = randomBytes(32).toString("hex");
  const staticFiles = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) =>
    [path, { body: await readFile(new URL(`./${file}`, import.meta.url)), type }])));
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
      if (assets.has(path)) {
        if (req.method !== "GET") throw new InboxError("method", "Only GET is supported.", 405);
        const file = staticFiles.get(path);
        res.writeHead(200, { "Content-Type": file.type });
        res.end(file.body);
        return;
      }
      if (!["/api/state", "/api/refresh", "/api/more", "/api/filters", "/api/settings", "/api/read"].includes(path)) {
        throw new InboxError("not_found", "Route not found.", 404);
      }
      if (!authorized(req.headers.authorization, secret) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
        throw new InboxError("forbidden", "This request is not authorized for the canvas.", 403);
      }
      if (path === "/api/settings" && !preferences) {
        throw new InboxError("settings_unavailable", "Notification settings are unavailable.", 503);
      }
      if (path === "/api/state" || (path === "/api/settings" && req.method === "GET")) {
        if (req.method !== "GET") throw new InboxError("method", "Only GET is supported.", 405);
        if (path === "/api/settings") return json(200, await preferences.read());
      } else {
        if (req.method !== "POST") throw new InboxError("method", "Only POST is supported.", 405);
        if (req.headers.origin !== origin) throw new InboxError("origin", "A same-origin request is required.", 403);
        const input = await readBody(req);
        if (!["/api/filters", "/api/settings", "/api/read"].includes(path) && Object.keys(input).length) {
          throw new InboxError("invalid_input", "This action takes an empty object.", 400);
        }
        if (path === "/api/refresh") await inbox.refresh();
        if (path === "/api/more") await inbox.more();
        if (path === "/api/filters") await inbox.setFilters(input);
        if (path === "/api/settings") return json(200, await preferences.update(input));
        if (path === "/api/read") await inbox.markRead(input);
      }
      json(200, inbox.snapshot());
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    url: `${origin}/#${secret}`,
    inbox,
    async close() {
      if (closed) return;
      closed = true;
      inbox.close();
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

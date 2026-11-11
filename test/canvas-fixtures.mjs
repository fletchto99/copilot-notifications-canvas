import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubClient } from "../src/provider/github.mjs";
import { Inbox } from "../src/provider/inbox.mjs";
import { DesktopNotifications } from "../src/provider/desktop.mjs";
import { Preferences } from "../src/provider/settings.mjs";
import { startServer } from "../src/provider/server.mjs";
import { Updates, CURRENT_VERSION } from "../src/provider/updates.mjs";
import { http, thread } from "./fixtures.mjs";
import { apiTarget, reportedWorkflow } from "../src/shared/model.mjs";
import { loadDevelopmentAPI } from "../src/provider/development.mjs";
import { CopilotHandoff } from "../src/provider/copilot.mjs";
import { copilotHost } from "./fixtures/copilot-host.mjs";

export async function createCanvasFixture({
  assetFailure = false, desktopEnabled = false, packaged = false, development, developmentApiBaseUrl, log: report = () => {},
  now = Date.now, copilotEnabled = false, findNotifier = async () => "/synthetic/bin/terminal-notifier",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "notification-fixture-"));
  const directory = join(root, "home", "extensions", "github-notifications", "artifacts");
  const writes = [];
  const doneWrites = [];
  const deliveries = [];
  const requests = [];
  const errors = [];
  const warnings = [];
  const target = apiTarget(packaged ? undefined : developmentApiBaseUrl);
  let assetsUnavailable = assetFailure;
  let requestHook;
  let offset = 0;
  const rows = Array.from({ length: 53 }, (_, index) => {
    const id = String(index + 1);
    const titles = {
      1: "<img src=x onerror=alert(1)> Needle widget 1",
      2: "Needle widget 2",
      3: "Needle tool",
      51: "Needle older widget",
    };
    return thread(id, {
      updated_at: new Date(Date.UTC(2026, 0, 10, 12, 0, 53 - index)).toISOString(),
      repository: { full_name: index === 2 ? "example/tools" : "example/widgets" },
      subject: { title: titles[id] ?? `Synthetic notification ${id}`, type: "Issue", url: null },
    });
  });
  const run = async args => {
    const endpoint = args.at(-1);
    requests.push(endpoint);
    const intercepted = await requestHook?.(args);
    if (intercepted !== undefined) return intercepted;
    if (endpoint === "/repos/fletchto99/copilot-notifications-canvas/releases/latest" && args.includes("GET")) {
      return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
    }
    if (endpoint === (target.custom ? `${target.baseUrl}/user` : "/user") && args.includes("GET")) {
      return http({ id: 7 });
    }
    if (endpoint === "graphql") {
      assert.ok(args.includes("POST") && !target.custom);
      const value = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const discussion = value("query").includes("discussion(number:");
      const row = rows.find(row => row.subject.url ===
        `https://api.github.com/repos/${value("owner")}/${value("name")}/${discussion ? "discussions" : "pulls"}/${value("number")}`);
      assert.ok(row, "Unexpected synthetic GraphQL lookup");
      if (discussion) return http({ data: { repository: { discussion: {
        viewerDidAuthor: row.authoredByViewer ?? false,
        ...(row.subjectDetails ?? { closed: false, isAnswered: false, stateReason: null }),
      } } } });
      return http({ data: { repository: { pullRequest: {
        isInMergeQueue: row.mergeQueued ?? false,
        state: row.subjectDetails?.merged ? "MERGED" : (row.subjectDetails?.state ?? "open").toUpperCase(),
        headRefOid: row.subjectDetails && Object.hasOwn(row.subjectDetails, "head") ? row.subjectDetails.head?.sha : "b".repeat(40),
      } } } });
    }
    if (args.includes("PATCH") || args.includes("DELETE")) {
      const path = new URL(endpoint, target.origin).pathname.slice(target.prefix.length);
      const match = /^\/notifications\/threads\/(\d+)$/.exec(path);
      const row = rows.find(item => item.id === match?.[1]);
      assert.ok(row && (args.includes("DELETE") || row.unread), `Unexpected synthetic write: ${endpoint}`);
      row.unread = false;
      writes.push(row.id);
      if (args.includes("DELETE")) {
        row.done = true;
        doneWrites.push(row.id);
      }
      return `HTTP/2 ${args.includes("DELETE") ? 204 : 205} Synthetic\r\n\r\n`;
    }
    const url = new URL(endpoint, "https://api.github.com");
    const attempt = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url.pathname.slice(target.prefix.length));
    if (args.includes("GET") && url.origin === target.origin && attempt) {
      const candidates = rows.filter(row => row.repository.full_name === attempt[1]).flatMap(row => [
        ...(row.workflowRunAttempts ?? []),
        ...(row.workflowRunResults?.workflow_runs ?? []),
        ...(row.subject.url === `${target.baseUrl}/repos/${attempt[1]}/actions/runs/${attempt[2]}` ? [row.subjectDetails] : []),
      ]);
      const run = candidates.find(run => run && String(run.id) === attempt[2] && String(run.run_attempt) === attempt[3]);
      assert.ok(run, "Unexpected synthetic workflow attempt lookup");
      return http(run);
    }
    const jobs = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/jobs$/.exec(url.pathname.slice(target.prefix.length));
    if (args.includes("GET") && url.origin === target.origin && jobs) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("filter"), jobs[3] ? null : "latest");
      const selected = rows.filter(row => row.repository.full_name === jobs[1]);
      assert.ok(selected.some(row => row.subject.url === `${target.baseUrl}/repos/${jobs[1]}/actions/runs/${jobs[2]}` ||
        row.workflowRunResults?.workflow_runs.some(run => String(run.id) === jobs[2])), "Unexpected synthetic job lookup");
      const items = selected.flatMap(row => row.workflowJobs ?? [])
        .filter(job => String(job.run_id) === jobs[2] && (!jobs[3] || String(job.run_attempt) === jobs[3]));
      return http({ total_count: items.length, jobs: items });
    }
    if (args.includes("GET") && url.origin === target.origin && url.searchParams.has("check_suite_id")) {
      const suiteId = url.searchParams.get("check_suite_id");
      const row = rows.find(row => row.subject.url ===
        `${url.origin}${url.pathname.replace(/\/actions\/runs$/, `/check-suites/${suiteId}`)}`);
      assert.ok(row, "Unexpected synthetic workflow run lookup");
      assert.equal(url.searchParams.get("per_page"), "2");
      return http(row.workflowRunResults ?? { total_count: 0, workflow_runs: [] });
    }
    if (args.includes("GET") && url.origin === target.origin &&
        /^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(url.pathname.slice(target.prefix.length))) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.ok(url.searchParams.has("created"));
      const matching = rows.filter(row => !row.subject.url &&
        url.pathname === `${target.prefix}/repos/${row.repository.full_name}/actions/runs` &&
        reportedWorkflow(row.subject.title)?.branch === url.searchParams.get("branch"));
      assert.ok(matching.length, "Unexpected synthetic workflow matching request");
      const runs = [...new Map(matching.flatMap(row => row.workflowRunResults?.workflow_runs ?? []).map(run => [run.id, run])).values()];
      return http({ total_count: runs.length, workflow_runs: runs });
    }
    if (args.includes("GET") && url.origin === target.origin &&
        /^\/repos\/[^/]+\/[^/]+\/(?:(?:issues|pulls|releases|check-suites|actions\/runs)\/\d+|commits\/[a-f0-9]{7,40})$/.test(url.pathname.slice(target.prefix.length))) {
      const row = rows.find(row => row.subject.url === url.href);
      assert.ok(row, `Unexpected synthetic subject lookup: ${endpoint}`);
      return http({ user: { id: row.authoredByViewer ? 7 : 8 },
        ...(row.subject.type === "PullRequest" ? { head: { sha: "b".repeat(40) } } : {}),
        ...(row.subjectDetails ?? (row.subject.type === "CheckSuite"
          ? { status: "completed", conclusion: "success" } : { state: "open", merged: false, draft: false })) });
    }
    assert.ok(args.includes("GET") && url.origin === target.origin && url.pathname === `${target.prefix}/notifications`,
      `Unexpected request: ${endpoint}`);
    const offset = (Number(url.searchParams.get("page")) - 1) * 50;
    const selected = rows.filter(row => url.searchParams.get("all") === "false" ? row.unread :
      url.searchParams.get("is_done") !== "false" || !row.done);
    const next = new URL(url);
    next.searchParams.set("page", String(Number(url.searchParams.get("page")) + 1));
    return http(selected.slice(offset, offset + 50), offset + 50 < selected.length
      ? { link: `<${next.href}>; rel="next"` } : {});
  };
  const client = new GitHubClient({ run, now: () => now() + offset, apiBaseUrl: target.baseUrl });
  const preferences = new Preferences({ directory });
  const log = (message, options) => {
    (options.level === "warning" ? warnings : errors).push(message);
    report(message, options);
  };
  const desktop = new DesktopNotifications({
    preferences, client, now: () => now() + offset, platform: "darwin",
    findNotifier,
    notify: async message => { deliveries.push(message); },
    log,
  });
  const updates = new Updates({ run: async args => {
    assert.equal(args.at(-1), "/repos/fletchto99/copilot-notifications-canvas/releases/latest");
    return http({ tag_name: `v${CURRENT_VERSION}`, draft: false, prerelease: false });
  }, log, now: () => now() + offset });
  const inbox = new Inbox(client);
  const syntheticHost = copilotEnabled ? copilotHost() : undefined;
  const copilot = syntheticHost ? new CopilotHandoff(inbox, syntheticHost.host, { log, preferences }) : undefined;
  let server;
  let registration;
  let closing;
  function close() {
    return closing ??= (async () => {
      inbox.close();
      try {
        await server?.close();
        await registration;
      } finally {
        try {
          await desktop.close();
        } finally {
          updates.close();
          await rm(root, { recursive: true, force: true });
        }
      }
    })();
  }
  try {
    if (desktopEnabled) await preferences.update({ desktopNotifications: true });
    if (developmentApiBaseUrl !== undefined) await preferences.updateDevelopmentAPI({ baseUrl: developmentApiBaseUrl });
    const developmentAPI = developmentApiBaseUrl !== undefined && !packaged ? await loadDevelopmentAPI(preferences) : undefined;
    server = packaged
      ? await (await import("./browser/package-fixtures.mjs")).startPackagedCanvas(root, run, log, syntheticHost?.rpc)
      : await startServer(inbox, {
        preferences, desktop: target.custom ? undefined : desktop, updates, development, developmentAPI, log, copilot,
        read: (path, options) => {
          if (assetsUnavailable && path.pathname.endsWith("/app.mjs")) {
            throw Object.assign(new Error("Synthetic asset failure"), { code: "ENOENT" });
          }
          return readFile(path, options);
        },
      });
    registration = server.ready?.then(ready => {
      if (ready && !target.custom) desktop.add("synthetic-fixture");
    });
    const advance = ms => { offset += ms; return now() + offset; };
    return {
      root, url: server.url, rows, writes, doneWrites, requests, preferences, deliveries, desktop, errors, warnings, close,
      copilot, copilotHost: syntheticHost,
      setCopilotTime: async time => {
        assert.ok(syntheticHost && Number.isSafeInteger(time) && time >= 0);
        if (packaged) await server.setTime(time);
        else {
          await syntheticHost.host.pending;
          syntheticHost.host.now = () => time;
        }
      },
      setRequestHook: hook => { requestHook = hook; },
      advance,
      advanceProviderTime: async ms => {
        const time = advance(ms);
        if (packaged) await server.setTime(time);
        return time;
      },
      recoverAssets: () => { assetsUnavailable = false; },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

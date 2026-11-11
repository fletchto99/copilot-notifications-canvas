import test from "node:test";
import assert from "node:assert/strict";
import { runInContext } from "node:vm";
import { staticSubjectTypes, thread } from "./fixtures.mjs";
import { renderer, settle } from "./renderer-fixtures.mjs";
import { octicons } from "../src/renderer/octicons.mjs";

const shape = node => node.querySelectorAll("path").map(path => path.attributes.d).join(" ");
const expectedShape = name => octicons[name].paths.join(" ");

test("state icons have accessible names without hover tooltips or visible status text in every view", async () => {
  const cases = [
    ["Issue", "open", "Open"], ["Issue", "closed", "Closed"],
    ["Issue", "not_planned", "Closed (not planned)"], ["Issue", "duplicate", "Closed (duplicate)"],
    ["PullRequest", "open", "Open"], ["PullRequest", "draft", "Draft"],
    ["PullRequest", "closed", "Closed"], ["PullRequest", "merged", "Merged"],
    ["PullRequest", null, "Status not loaded yet"], ["PullRequest", "__proto__", "Status not loaded yet"],
    ["PullRequest", "merge_queued", "In merge queue"],
    ...[["success", "Passing"], ["failure", "Failed"], ["queued", "Queued"], ["in_progress", "In progress"],
      ["waiting", "Waiting"], ["requested", "Requested"], ["pending", "Pending"], ["neutral", "Neutral"],
      ["cancelled", "Cancelled"], ["skipped", "Skipped"], ["timed_out", "Timed out"],
      ["action_required", "Action required"], ["startup_failure", "Startup failure"], ["stale", "Stale"]]
      .map(([state, label]) => ["CheckSuite", state, label]),
    ...[["open", "Open"], ["answered", "Answered"], ["closed", "Closed"],
      ["duplicate", "Closed (duplicate)"], ["outdated", "Closed (outdated)"]]
      .map(([state, label]) => ["Discussion", state, label]),
  ];
  const rows = cases.map(([type], index) => thread(String(index + 1), { subject: {
    type, title: `Synthetic state ${index}`,
    url: `https://api.github.com/repos/example/widgets/${type === "Issue" ? "issues" : type === "CheckSuite" ? "check-suites" :
      type === "Discussion" ? "discussions" : "pulls"}/${index + 1}`,
  } }));
  const subjectStates = Object.fromEntries(cases.map(([, subjectState], index) => [String(index + 1), { subjectState }]));
  const ui = await renderer({ initialRows: rows, subjectStates });
  try {
    for (const groupBy of ["repo", "none", "date"]) {
      ui.ids.get("group-by").value = groupBy;
      await ui.ids.get("group-by").events.change();
      const fields = ui.ids.get("groups").querySelectorAll(".notification-subject");
      assert.equal(fields.length, cases.length);
      for (const [index, field] of fields.entries()) {
        const icon = field.querySelectorAll(".subject-icon")[0];
        const type = cases[index][0].replace(/([a-z])([A-Z])/g, "$1 $2");
        assert.equal(icon.attributes["aria-label"], `${type}: ${cases[index][2]}`);
        assert.equal(icon.title, undefined);
        assert.equal(icon.attributes.role, "img");
        assert.equal(field.querySelectorAll(".subject-state").length, 0);
        assert.equal(field.children.length, 2);
        const svg = field.querySelectorAll("svg")[0];
        assert.equal(svg.attributes["aria-hidden"], "true");
        assert.equal(svg.attributes.width, "16");
        assert.equal(field.dataset.subjectType, cases[index][0]);
      }
      const issueShapes = fields.filter(field => field.dataset.subjectType === "Issue")
        .map(shape);
      assert.equal(issueShapes[3], expectedShape("skip"),
        "duplicate issues show a slashed circle");
      assert.equal(issueShapes[3], issueShapes[2], "duplicate and not-planned issues share a slashed circle");
      assert.notEqual(issueShapes[3], issueShapes[1], "duplicate issues do not show the completed checkmark");
      const queuedShape = shape(fields[cases.findIndex(([, state]) => state === "merge_queued")]);
      assert.equal(queuedShape, expectedShape("git-merge-queue"),
        "queued PRs show two dots leading into merge nodes");
      const shapes = fields.slice(4, 8).map(shape);
      assert.equal(new Set([...shapes, queuedShape]).size, 5, "open, draft, closed, merged, and queued PRs have different shapes");
      const discussions = fields.filter(field => field.dataset.subjectType === "Discussion")
        .map(shape);
      assert.equal(new Set(discussions).size, 5, "open, answered, closed, duplicate and outdated discussions have distinct shapes");
      assert.equal(discussions[1], expectedShape("check-circle"), "answered discussions have an answer checkmark");
      assert.equal(discussions[2], expectedShape("discussion-closed"), "closed discussions have a checkmark");
    }
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
  }
});

test("release notifications have static tag icons in every view without status loading or lookups", async () => {
  const ui = await renderer({
    initialRows: [
      thread("1", { subject: {
        type: "Release", title: "Synthetic v1.2.0", url: "https://api.github.com/repos/example/widgets/releases/123",
      } }),
      thread("2", { unread: false, subject: { type: "Release", title: "Synthetic v1.1.0", url: null } }),
    ],
    subjectsLoading: true,
  });
  try {
    for (const groupBy of ["repo", "none", "date"]) {
      ui.ids.get("group-by").value = groupBy;
      await ui.ids.get("group-by").events.change();
      await settle();
      const groups = ui.ids.get("groups");
      const fields = groups.querySelectorAll(".notification-subject");
      assert.equal(fields.length, 2);
      for (const field of fields) {
        assert.equal(field.className, "notification-subject");
        assert.equal(field.dataset.subjectType, "Release");
        assert.equal(field.querySelectorAll(".notification-type")[0].textContent, "Release");
        const icon = field.querySelectorAll(".subject-icon")[0];
        assert.equal(icon.attributes["aria-label"], "Release");
        assert.equal(icon.attributes.role, "img");
        assert.equal(icon.title, undefined);
        assert.equal(icon.dataset.checkedAt, undefined);
        const svg = icon.querySelectorAll("svg")[0];
        assert.equal(svg.attributes["aria-hidden"], "true");
        assert.equal(svg.attributes.width, "16");
        assert.equal(shape(svg), expectedShape("tag"));
      }
      assert.deepEqual(groups.querySelectorAll(".row-link").map(link => link.href),
        ["https://github.com/example/widgets/releases", "https://github.com/example/widgets/releases"]);
      assert.equal(groups.querySelectorAll(".destination").length, 0);
      assert.equal(groups.querySelectorAll(".sr-only").filter(node => node.textContent === "Open repository releases").length, 2);
      await ui.fireTimer(1000);
      assert.ok(groups.querySelectorAll(".notification-subject").every((field, index) => field === fields[index]));
      assert.ok(groups.querySelectorAll(".subject-icon").every(icon => icon.attributes["aria-label"] === "Release"));
      assert.equal(groups.querySelectorAll(".subject-loading").length, 0);
    }
    assert.ok(ui.githubCalls.every(args => args.at(-1).startsWith("/notifications?")));
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("known types get static icons and unknown or untrusted types get an accessible bell", async () => {
  const types = [...staticSubjectTypes, "FutureSubject", "__proto__", "constructor", "toString", "<img src=x onerror=alert(1)>", "", " "];
  const labels = types.map(type => type.replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Notification");
  const bell = expectedShape("bell");
  const ui = await renderer({
    initialRows: types.map((type, index) => thread(String(index + 1), {
      unread: index % 2 === 0, subject: { type, title: `Synthetic type ${index}`, url: null },
    })),
    subjectsLoading: true,
    subjectStates: Object.fromEntries(types.map((_, index) =>
      [String(index + 1), { subjectState: null, subjectCheckedAt: Date.now() }])),
  });
  try {
    for (const groupBy of ["repo", "none", "date"]) {
      ui.ids.get("group-by").value = groupBy;
      ui.ids.get("group-by").events.change();
      await settle();
      const groups = ui.ids.get("groups");
      const fields = groups.querySelectorAll(".notification-subject");
      assert.equal(fields.length, types.length);
      const paths = [];
      for (const [index, field] of fields.entries()) {
        assert.equal(field.className, "notification-subject");
        assert.equal(field.dataset.subjectType, types[index]);
        assert.equal(field.querySelectorAll(".notification-type")[0].textContent, labels[index]);
        const icon = field.querySelectorAll(".subject-icon")[0];
        assert.equal(icon.attributes["aria-label"], labels[index]);
        assert.equal(icon.attributes.role, "img");
        assert.equal(icon.title, undefined);
        assert.equal(icon.dataset.checkedAt, undefined);
        const svg = icon.querySelectorAll("svg")[0];
        assert.equal(svg.attributes["aria-hidden"], "true");
        assert.equal(svg.attributes.width, "16");
        paths.push(shape(svg));
      }
      assert.ok(paths.slice(0, staticSubjectTypes.length).every(path => path && path !== bell));
      assert.ok(paths.slice(staticSubjectTypes.length).every(path => path === bell));
      assert.equal(new Set(paths.slice(0, staticSubjectTypes.length)).size, 6);
      assert.equal(paths[2], paths[3], "security-related types share a shield");
      assert.equal(paths[3], paths[4]);
      assert.equal(groups.querySelectorAll("img").length, 0);
      assert.equal(groups.querySelectorAll(".subject-loading").length, 0);
      await ui.fireTimer(1000);
      assert.ok(groups.querySelectorAll(".notification-subject").every((field, index) => field === fields[index]));
      assert.deepEqual(groups.querySelectorAll(".subject-icon").map(icon => icon.attributes["aria-label"]), labels);
    }
    assert.ok(ui.githubCalls.every(args => args.at(-1).startsWith("/notifications?")));
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("row metadata never includes custom destination hints for any notification type", async () => {
  const types = ["Issue", "PullRequest", "CheckSuite", "Discussion", ...staticSubjectTypes, "FutureSubject"];
  const ui = await renderer({
    initialRows: types.map((type, index) => thread(String(index + 1), {
      subject: { type, title: `Synthetic type ${index}`, url: null },
    })),
  });
  try {
    for (const groupBy of ["repo", "none", "date"]) {
      ui.ids.get("group-by").value = groupBy;
      ui.ids.get("group-by").events.change();
      await settle();
      const groups = ui.ids.get("groups");
      assert.equal(groups.querySelectorAll(".destination").length, 0);
      for (const metadata of groups.querySelectorAll(".metadata")) {
        assert.equal(metadata.children.filter(node => !node.hidden).length, groupBy === "repo" ? 3 : 4);
        assert.equal(metadata.querySelectorAll(".sr-only").length, 0);
        assert.ok(metadata.querySelectorAll("span").every(node => !node.textContent.startsWith("Open ")));
      }
      for (const [index, link] of groups.querySelectorAll(".row-link").entries()) {
        const label = types[index] === "Release" ? "Open repository releases" :
          types[index] === "CheckSuite" ? "Open repository Actions" : "Open GitHub inbox";
        assert.ok(link.querySelectorAll(".sr-only").some(node => node.textContent === label));
      }
    }
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
    ui.inbox.close();
  }
});

test("unavailable status is explicit, untrusted errors are text, and other types keep their labels", async () => {
  const ui = await renderer({
    initialRows: [thread("1"), thread("2", { subject: { type: "Discussion", title: "Synthetic discussion", url: null } })],
    subjectStates: { 1: { subjectState: null, subjectStateError: "<img src=x onerror=alert(1)>" } },
  });
  try {
    const fields = ui.ids.get("groups").querySelectorAll(".notification-subject");
    assert.equal(fields.length, 2);
    const icon = fields[0].querySelectorAll(".subject-icon")[0];
    assert.equal(icon.textContent, "");
    assert.equal(icon.attributes["aria-label"], "Pull Request: Status unavailable. <img src=x onerror=alert(1)>");
    assert.equal(icon.title, undefined);
    assert.equal(icon.querySelectorAll("img").length, 0);
    assert.deepEqual(ui.ids.get("groups").querySelectorAll(".notification-type").map(node => node.textContent),
      ["Pull Request #42", "Discussion"]);
  } finally {
    ui.window.events.pagehide();
  }
});

test("reported check suite results are identified in screen-reader descriptions without hover tooltips", async () => {
  const ui = await renderer({ initialRows: [thread("1", { subject: {
    type: "CheckSuite", title: "Synthetic build workflow run failed for main", url: null,
  } })] });
  try {
    const icon = ui.ids.get("groups").querySelectorAll(".subject-icon")[0];
    assert.equal(icon.attributes["aria-label"], "Check Suite: Failed. Reported by this notification; may not reflect a later rerun.");
    assert.equal(icon.title, undefined);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-state").length, 0);
    assert.equal(ui.ids.get("groups").querySelectorAll(".destination").length, 0);
    assert.ok(ui.ids.get("groups").querySelectorAll(".sr-only").some(node => node.textContent === "Open repository Actions"));
    assert.equal(ui.ids.get("groups").querySelectorAll(".row-link")[0].title, undefined);
  } finally {
    ui.window.events.pagehide();
  }
});

test("inferred run links disclose uncertainty accessibly without visible metadata or changing the reported status", async () => {
  const ui = await renderer({
    initialRows: [thread("1", { subject: {
      type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null,
    } })],
    subjectStates: { 1: {
      url: "https://github.com/example/widgets/actions/runs/123/attempts/1", direct: true,
      label: "Open inferred workflow run results", subjectLinkSource: "inferred",
    } },
  });
  try {
    const groups = ui.ids.get("groups");
    const link = groups.querySelectorAll(".row-link")[0];
    assert.equal(link.href, "https://github.com/example/widgets/actions/runs/123/attempts/1");
    assert.equal(link.target, "_blank");
    assert.equal(link.title, undefined);
    assert.equal(groups.querySelectorAll(".destination").length, 0);
    assert.ok(groups.querySelectorAll(".sr-only").some(node => node.textContent === "Open inferred workflow run results"));
    const icon = groups.querySelectorAll(".subject-icon")[0];
    assert.match(icon.attributes["aria-label"], /^Check Suite: Failed\. Reported by this notification/);
    assert.match(icon.attributes["aria-label"], /Run link inferred.*not confirmed by GitHub/);
    assert.equal(icon.title, undefined);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
  }
});

test("job-log destinations are accessible without a redundant visible destination or a whole-row tooltip", async () => {
  for (const inferred of [false, true]) {
    const label = inferred ? "Open failed job logs for inferred workflow run" : "Open failed job logs";
    const ui = await renderer({
      initialRows: [thread("1", { subject: { type: "CheckSuite", title: "Synthetic build", url: null } })],
      subjectStates: { 1: {
        subjectState: "failure", subjectStateError: null,
        url: "https://github.com/example/widgets/actions/runs/123/job/456", direct: true, label,
        subjectLinkTarget: "job", ...(inferred ? { subjectLinkSource: "inferred" } : {}),
      } },
    });
    try {
      const groups = ui.ids.get("groups");
      const link = groups.querySelectorAll(".row-link")[0];
      assert.equal(link.href, "https://github.com/example/widgets/actions/runs/123/job/456");
      assert.equal(link.target, "_blank");
      assert.equal(link.title, undefined);
      assert.ok(groups.querySelectorAll(".sr-only").some(node => node.textContent === label));
      assert.equal(groups.querySelectorAll(".destination").length, 0);
      const icon = groups.querySelectorAll(".subject-icon")[0];
      assert.match(icon.attributes["aria-label"], /Opens the only failed job's log viewer/);
      assert.equal(icon.title, undefined);
      assert.deepEqual(ui.patches, []);
      assert.deepEqual(ui.deletions, []);
    } finally {
      ui.window.events.pagehide();
    }
  }
});

test("CI rows wait for their initial destination even with a known result and then regain native navigation", async () => {
  const subjectStates = { 1: { subjectState: "failure", subjectLinkLoading: true } };
  const ui = await renderer({ initialRows: [thread("1", { subject: {
    type: "CheckSuite", title: "Synthetic build workflow run failed for main branch", url: null,
  } })], subjectStates });
  try {
    const link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    assert.equal(link.href, "");
    assert.equal(link.attributes.role, "link");
    assert.equal(link.attributes["aria-disabled"], "true");
    assert.equal(link.attributes["aria-busy"], "true");
    assert.equal(link.tabIndex, 0);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 1);
    assert.match(link.querySelectorAll(".subject-icon")[0].attributes["aria-label"], /Failed\. Loading run destination/);
    let prevented = 0;
    for (const metaKey of [false, true]) link.events.click({ metaKey, preventDefault: () => { prevented++; } });
    link.events.auxclick({ button: 1, preventDefault: () => { prevented++; } });
    assert.equal(prevented, 3);
    assert.equal(ui.ids.get("groups").querySelectorAll(".mark-read")[0].disabled, false);
    assert.equal(ui.ids.get("groups").querySelectorAll(".mark-done")[0].disabled, false);
    link.focus();
    subjectStates[1] = {
      subjectState: "failure", subjectLinkLoading: false, subjectLinkSource: "inferred",
      subjectLinkTarget: "job", direct: true, label: "Open failed job logs for inferred workflow run",
      url: "https://github.com/example/widgets/actions/runs/123/job/456",
    };
    await ui.fireTimer();
    assert.equal(ui.ids.get("groups").querySelectorAll(".row-link")[0], link);
    assert.equal(link.href, subjectStates[1].url);
    assert.equal(link.attributes["aria-disabled"], undefined);
    assert.equal(link.attributes["aria-busy"], undefined);
    assert.equal(ui.document.activeElement, link);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 0);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-failure").length, 1);
    assert.equal(ui.ids.get("groups").querySelectorAll(".destination").length, 0);
    link.events.click({ metaKey: true, preventDefault: () => assert.fail("Resolved links must navigate natively") });
    subjectStates[1] = {
      subjectState: "failure", subjectLinkLoading: false, direct: false,
      url: "https://github.com/example/widgets/actions", label: "Open repository Actions",
    };
    await ui.fireTimer();
    assert.equal(ui.ids.get("groups").querySelectorAll(".row-link")[0], link);
    assert.equal(link.href, subjectStates[1].url);
    assert.ok(link.querySelectorAll(".sr-only").some(node => node.textContent === "Open repository Actions" && !node.hidden));
    subjectStates[1].subjectLinkLoading = true;
    await ui.fireTimer();
    assert.equal(link.href, "");
    assert.equal(link.attributes["aria-disabled"], "true");
    link.events.click({ preventDefault: () => { prevented++; } });
    assert.equal(prevented, 4);
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
  }
});

test("multi-path icons add and remove paths across loading, closed and reopened states without replacing controls", async t => {
  const subjectStates = { 1: { subjectState: "open" } };
  const ui = await renderer({
    initialRows: [thread("1", { subject: { type: "Issue", title: "Synthetic issue",
      url: "https://api.github.com/repos/example/widgets/issues/1" } })],
    subjectStates,
  });
  t.after(() => { ui.window.events.pagehide(); ui.inbox.close(); });
  const groups = ui.ids.get("groups");
  const icon = groups.querySelectorAll(".subject-icon")[0];
  const svg = icon.children[0];
  const firstPath = svg.children[0];
  const read = groups.querySelectorAll(".mark-read")[0];
  read.focus();
  for (const [subjectState, subjectLoading, name] of [
    ["open", false, "issue-opened"], ["closed", false, "issue-closed"],
    [null, true, "sync"], ["open", false, "issue-opened"],
  ]) {
    subjectStates[1] = { subjectState };
    ui.setSubjectsLoading(subjectLoading);
    await runInContext("update()", ui.context);
    assert.equal(icon.children[0], svg);
    assert.equal(svg.children[0], firstPath);
    assert.deepEqual(svg.querySelectorAll("path").map(path => path.attributes.d), octicons[name].paths);
    assert.equal(svg.getAttribute("viewBox"), `0 0 ${octicons[name].width} 24`);
    assert.equal(svg.getAttribute("width"), "16");
    assert.equal(svg.getAttribute("height"), "16");
    assert.equal(svg.getAttribute("fill"), "currentColor");
    assert.equal(svg.getAttribute("stroke"), "none");
    assert.equal(ui.document.activeElement, read);
  }
});

test("subject updates preserve controls and metadata descendants without creating nodes in a large loaded inbox", async () => {
  for (const groupBy of ["repo", "none", "date"]) {
    const subjectStates = {};
    const ui = await renderer({
      initialRows: Array.from({ length: 1000 }, (_, index) => thread(String(index + 1))),
      subjectStates, storedSettings: { groupBy },
    });
    try {
      const groups = ui.ids.get("groups");
      const controls = groups.querySelectorAll("[data-focus-key]");
      const icons = groups.querySelectorAll(".subject-icon");
      const fields = groups.querySelectorAll(".notification-subject");
      const labels = groups.querySelectorAll(".notification-type");
      const svg = icons[0].querySelectorAll("svg")[0];
      const path = svg.querySelectorAll("path")[0];
      const shape = path.attributes.d;
      const read = groups.querySelectorAll(".mark-read")[0];
      read.focus();
      read.parentNode.dataset.tooltipDismissed = "true";
      let created = 0;
      const create = ui.document.createElement;
      ui.document.createElement = tag => { created++; return create(tag); };
      subjectStates[1] = { subjectState: "merged", subjectCheckedAt: Date.now() };
      await ui.fireTimer();
      assert.ok(groups.querySelectorAll("[data-focus-key]").every((node, index) => node === controls[index]));
      assert.ok(groups.querySelectorAll(".subject-icon").every((node, index) => node === icons[index]));
      assert.ok(groups.querySelectorAll(".notification-subject").every((node, index) => node === fields[index]));
      assert.ok(groups.querySelectorAll(".notification-type").every((node, index) => node === labels[index]));
      assert.equal(icons[0].querySelectorAll("svg")[0], svg);
      assert.equal(svg.querySelectorAll("path")[0], path);
      assert.notEqual(path.attributes.d, shape);
      assert.equal(created, 0, "a status result updates existing metadata nodes");
      assert.match(groups.querySelectorAll(".subject-icon")[0].attributes["aria-label"], /Pull Request: Merged\. Checked/);
      assert.equal(ui.document.activeElement, read);
      assert.equal(read.parentNode.dataset.tooltipDismissed, "true");
      created = 0;
      await ui.fireTimer();
      assert.equal(created, 0, "an unchanged poll does not replace metadata");
      subjectStates[1] = { subjectState: null, subjectStateError: "Synthetic status unavailable." };
      await ui.fireTimer();
      assert.equal(groups.querySelectorAll(".subject-icon")[0], icons[0]);
      assert.equal(icons[0].dataset.checkedAt, undefined);
      assert.equal(icons[0].attributes["aria-label"], "Pull Request: Status unavailable. Synthetic status unavailable.");
      assert.equal(created, 0);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});

test("unknown CI status announces destination loading without an icon tooltip", async () => {
  const ui = await renderer({ initialRows: [thread("1", { subject: {
    type: "CheckSuite", title: "Synthetic run", url: "https://api.github.com/repos/example/widgets/actions/runs/123",
  } })], subjectStates: { 1: { subjectState: null, subjectLinkLoading: true } } });
  try {
    const icon = ui.ids.get("groups").querySelectorAll(".subject-icon")[0];
    assert.equal(icon.attributes["aria-label"], "Check Suite: Loading run destination");
    assert.equal(icon.title, undefined);
  } finally {
    ui.window.events.pagehide();
  }
});

test("pending icons use one-second local polls and return to normal polling without refetching GitHub", async () => {
  const subjectStates = {};
  const ui = await renderer({ initialRows: [thread()], subjectStates, subjectsLoading: true });
  try {
    assert.ok([...ui.timers.values()].some(timer => timer.delay === 1000));
    const githubCalls = ui.githubCalls.length;
    const refreshCalls = ui.calls.filter(call => call.path === "/api/refresh").length;
    subjectStates["1"] = { subjectState: "merged" };
    ui.setSubjectsLoading(false);
    ui.advance(1000);
    await ui.fireTimer(1000);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-icon")[0].attributes["aria-label"], "Pull Request: Merged");
    assert.equal(ui.githubCalls.length, githubCalls);
    assert.equal(ui.calls.filter(call => call.path === "/api/refresh").length, refreshCalls);
    assert.ok([...ui.timers.values()].some(timer => timer.delay === 5000));
    assert.equal([...ui.timers.values()].some(timer => timer.delay === 1000), false);
  } finally {
    ui.window.events.pagehide();
  }
});

test("fast icon polling pauses when hidden and slows down after local connection errors", async () => {
  const ui = await renderer({ initialRows: [thread()], subjectsLoading: true });
  try {
    ui.intersect(false);
    assert.equal([...ui.timers.values()].some(timer => timer.delay === 1000), false);
    ui.intersect(true);
    await settle();
    assert.ok([...ui.timers.values()].some(timer => timer.delay === 1000));
    ui.setOffline(true);
    await ui.fireTimer(1000);
    assert.equal([...ui.timers.values()].some(timer => timer.delay === 1000), false);
    assert.ok([...ui.timers.values()].some(timer => timer.delay === 5000));
  } finally {
    ui.window.events.pagehide();
  }
});

test("initial statuses use spinners, while cached and unavailable statuses keep their icons", async () => {
  const subjectStates = {
    2: { subjectState: "merged" },
    3: { subjectState: null, subjectStateError: "Synthetic status unavailable." },
  };
  const ui = await renderer({ initialRows: [thread("1"), thread("2"), thread("3")], subjectStates, subjectsLoading: true });
  try {
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 1);
    const icons = ui.ids.get("groups").querySelectorAll(".subject-icon");
    assert.equal(icons[0].attributes["aria-label"], "Pull Request: Loading status");
    assert.equal(icons[1].attributes["aria-label"], "Pull Request: Merged");
    assert.match(icons[2].attributes["aria-label"], /Status unavailable/);
    assert.equal(icons[0].querySelectorAll("svg")[0].attributes.width, "16");
    subjectStates["1"] = { subjectState: "closed" };
    ui.setSubjectsLoading(false);
    await ui.fireTimer(1000);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 0);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-icon")[0].attributes["aria-label"], "Pull Request: Closed");
  } finally {
    ui.window.events.pagehide();
  }
});

test("renderer requests send the displayed grouping and browser time zone as ephemeral context", async () => {
  const ui = await renderer({ initialRows: [thread()], storedSettings: { groupBy: "date" } });
  try {
    await ui.fireTimer();
    const request = ui.calls.filter(call => call.path === "/api/state").at(-1);
    assert.equal(request.options.headers["X-Notification-Group-By"], "date");
    assert.equal(request.options.headers["X-Notification-Time-Zone"], Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(request.options.body, undefined);
  } finally {
    ui.window.events.pagehide();
  }
});

test("non-date groupings work without a browser time zone and date changes fail before saving", async () => {
  for (const groupBy of ["repo", "none"]) {
    const ui = await renderer({ initialRows: [thread("1"), thread("2")], storedSettings: { groupBy } });
    try {
      ui.context.Intl = Object.create(Intl);
      ui.context.Intl.DateTimeFormat = () => ({ resolvedOptions: () => ({ timeZone: undefined }) });
      await ui.fireTimer();
      await ui.ids.get("force-refresh").events.click();
      await ui.ids.get("groups").querySelectorAll(".mark-read")[0].events.click();
      await ui.ids.get("groups").querySelectorAll(".mark-done")[1].events.click();
      assert.deepEqual(ui.patches, ["/notifications/threads/1"]);
      assert.deepEqual(ui.deletions, ["/notifications/threads/2"]);
      assert.ok(ui.calls.every(call => !Object.hasOwn(call.options.headers, "X-Notification-Time-Zone")));
      const saves = ui.calls.filter(call => call.path === "/api/settings" && call.options.body).length;
      ui.ids.get("group-by").value = "date";
      ui.ids.get("group-by").events.change();
      await settle();
      assert.match(ui.ids.get("settings-error").textContent, /supported browser time zone/);
      assert.equal(ui.ids.get("group-by").value, groupBy);
      assert.equal(ui.calls.filter(call => call.path === "/api/settings" && call.options.body).length, saves);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});

test("status selection includes off-screen rows in display order and excludes collapsed groups in every view", async () => {
  for (const [groupBy, expected, remaining] of [
    ["repo", "1,3,2", "2"],
    ["none", "1,2,3", ""],
    ["date", "2,1,3", "1,3"],
  ]) {
    const ui = await renderer({
      initialRows: [
        thread("1", { updated_at: "2026-01-01T12:00:00Z" }),
        thread("2", { repository: { full_name: "example/tools" }, updated_at: "2026-01-02T12:00:00Z" }),
        thread("3", { updated_at: "2026-01-01T12:00:00Z" }),
      ],
      storedSettings: { groupBy },
    });
    try {
      const links = ui.ids.get("groups").querySelectorAll(".row-link");
      links[0].bounds = { top: -100, bottom: -40 };
      links[1].bounds = { top: 100, bottom: 160 };
      links[2].bounds = { top: 950, bottom: 1010 };
      ui.fireAnimationFrame();
      await settle();
      assert.equal(ui.subjectSelections.at(-1).join(","), expected, groupBy);
      ui.ids.get("groups").querySelectorAll(".repo-toggle")[0].events.click();
      ui.fireAnimationFrame();
      await settle();
      assert.equal(ui.subjectSelections.at(-1).join(","), remaining, groupBy);
      ui.ids.get("groups").querySelectorAll(".repo-toggle")[0].events.click();
      ui.fireAnimationFrame();
      await settle();
      assert.equal(ui.subjectSelections.at(-1).join(","), expected, groupBy);
      ui.ids.get("collapse").events.click();
      ui.fireAnimationFrame();
      await settle();
      assert.equal(ui.subjectSelections.at(-1).join(","), "");
      ui.ids.get("collapse").events.click();
      ui.fireAnimationFrame();
      await settle();
      assert.equal(ui.subjectSelections.at(-1).join(","), expected, groupBy);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
    assert.equal(ui.animationFrames.size, 0);
  }
});

test("scroll and resize events do not measure rows or request status", async () => {
  for (const count of [50, 100, 500]) {
    const ui = await renderer({ initialRows: Array.from({ length: count }, (_, index) => thread(String(index + 1))) });
    try {
      const links = ui.ids.get("groups").querySelectorAll(".row-link");
      links.forEach((link, index) => { link.bounds = { top: index * 60, bottom: index * 60 + 60 }; });
      ui.fireAnimationFrame();
      await settle();
      let measurements = 0;
      for (const link of links) {
        const bounds = link.getBoundingClientRect.bind(link);
        link.getBoundingClientRect = () => { measurements++; return bounds(); };
      }
      const calls = ui.calls.length;
      for (const event of ["scroll", "resize"]) {
        measurements = 0;
        ui.window.events[event]();
        assert.equal(measurements, 0, `${event} does not measure ${count} loaded rows`);
        assert.equal(ui.animationFrames.size, 0);
      }
      assert.equal(ui.calls.length, calls);
    } finally {
      ui.window.events.pagehide();
      ui.inbox.close();
    }
  }
});

test("refreshes restore focus only while the canvas document owns focus", async () => {
  for (const active of [false, true]) {
    const ui = await renderer({ initialRows: [thread()] });
    try {
      const link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
      link.focus();
      ui.setDocumentFocused(active);
      ui.setRows([thread("1", { subject: { type: "Issue", url: null, title: "Updated synthetic row" } })]);
      ui.advance();
      await ui.fireTimer();
      const replacement = ui.ids.get("groups").querySelectorAll(".row-link")[0];
      assert.equal(ui.document.activeElement, active ? replacement : ui.document.body);
    } finally {
      ui.window.events.pagehide();
    }
  }
});

test("refresh preserves pointer versus keyboard tooltip state and keyboard dismissal", async () => {
  const ui = await renderer({ initialRows: [thread()] });
  try {
    let control = ui.ids.get("groups").querySelectorAll(".mark-done")[0];
    ui.document.events.pointerdown();
    control.focus();
    control.events.focus();
    assert.equal(control.parentNode.dataset.tooltipKeyboard, "false");
    ui.setRows([thread("1", { subject: { type: "Issue", url: null, title: "Pointer refresh" } })]);
    ui.advance();
    await ui.fireTimer();
    control = ui.ids.get("groups").querySelectorAll(".mark-done")[0];
    assert.equal(ui.document.activeElement, control);
    assert.equal(control.parentNode.dataset.tooltipKeyboard, "false");
    ui.document.events.keydown({ key: "Tab" });
    control.events.keydown({ key: "Enter" });
    assert.equal(control.parentNode.dataset.tooltipKeyboard, "true");
    ui.document.events.keydown({ key: "Escape" });
    assert.equal(control.parentNode.dataset.tooltipDismissed, "true");
    ui.setRows([thread("1", { subject: { type: "Issue", url: null, title: "Keyboard refresh" } })]);
    ui.advance();
    await ui.fireTimer();
    control = ui.ids.get("groups").querySelectorAll(".mark-done")[0];
    assert.equal(ui.document.activeElement, control);
    assert.equal(control.parentNode.dataset.tooltipKeyboard, "true");
    assert.equal(control.parentNode.dataset.tooltipDismissed, "true");
  } finally {
    ui.window.events.pagehide();
  }
});

test("row activation and window blur suppress stale hover without intercepting navigation", async () => {
  const ui = await renderer({ initialRows: [thread()] });
  try {
    const root = ui.document.documentElement;
    const link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    const calls = ui.calls.length;
    const href = link.href;
    link.events.click({ metaKey: true, preventDefault: () => assert.fail("Native modified clicks must be preserved") });
    assert.equal(root.dataset.pointerHoverSuppressed, "true");
    assert.equal(link.href, href);
    assert.equal(link.target, "_blank");
    assert.equal(ui.calls.length, calls);
    ui.document.events.pointermove();
    assert.equal(root.dataset.pointerHoverSuppressed, undefined);
    link.events.auxclick({ button: 2 });
    assert.equal(root.dataset.pointerHoverSuppressed, undefined);
    link.events.auxclick({ button: 1 });
    assert.equal(root.dataset.pointerHoverSuppressed, "true");
    ui.document.events.pointerdown();
    assert.equal(root.dataset.pointerHoverSuppressed, undefined);
    ui.window.events.blur();
    assert.equal(root.dataset.pointerHoverSuppressed, "true");
    assert.equal(ui.ids.get("refresh-control").dataset.tooltipDismissed, "true");
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
  }
});

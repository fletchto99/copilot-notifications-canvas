import test from "node:test";
import assert from "node:assert/strict";
import { thread } from "./fixtures.mjs";
import { renderer, settle } from "./renderer-fixtures.mjs";

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
  ];
  const rows = cases.map(([type], index) => thread(String(index + 1), { subject: {
    type, title: `Synthetic state ${index}`,
    url: `https://api.github.com/repos/example/widgets/${type === "Issue" ? "issues" : type === "CheckSuite" ? "check-suites" : "pulls"}/${index + 1}`,
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
      const shapes = fields.slice(4, 8).map(field => field.querySelectorAll("path")[0].attributes.d);
      assert.equal(new Set(shapes).size, 4, "open, draft, closed, and merged PRs have different shapes");
    }
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
  }
});

test("unavailable status is explicit, untrusted errors are text, and other types keep their labels", async () => {
  const ui = await renderer({
    initialRows: [thread("1"), thread("2", { subject: { type: "Release", title: "Synthetic release", url: null } })],
    subjectStates: { 1: { subjectState: null, subjectStateError: "<img src=x onerror=alert(1)>" } },
  });
  try {
    const fields = ui.ids.get("groups").querySelectorAll(".notification-subject");
    assert.equal(fields.length, 1);
    const icon = fields[0].querySelectorAll(".subject-icon")[0];
    assert.equal(icon.textContent, "");
    assert.equal(icon.attributes["aria-label"], "Pull Request: Status unavailable. <img src=x onerror=alert(1)>");
    assert.equal(icon.title, undefined);
    assert.equal(icon.querySelectorAll("img").length, 0);
    assert.deepEqual(ui.ids.get("groups").querySelectorAll(".notification-type").map(node => node.textContent),
      ["Pull Request #42", "Release"]);
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
    let link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    assert.equal(link.href, undefined);
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
    link = ui.ids.get("groups").querySelectorAll(".row-link")[0];
    assert.equal(link.href, subjectStates[1].url);
    assert.equal(link.attributes["aria-disabled"], undefined);
    assert.equal(link.attributes["aria-busy"], undefined);
    assert.equal(ui.document.activeElement, link);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-loading").length, 0);
    assert.equal(ui.ids.get("groups").querySelectorAll(".subject-failure").length, 1);
    assert.equal(ui.ids.get("groups").querySelectorAll(".destination").length, 0);
    link.events.click({ metaKey: true, preventDefault: () => assert.fail("Resolved links must navigate natively") });
    assert.deepEqual(ui.patches, []);
    assert.deepEqual(ui.deletions, []);
  } finally {
    ui.window.events.pagehide();
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

test("viewport reports exclude collapsed and off-screen rows and update after resizing", async () => {
  const ui = await renderer({ initialRows: [thread("1"), thread("2")] });
  try {
    const links = ui.ids.get("groups").querySelectorAll(".row-link");
    links[0].bounds = { top: 950, bottom: 1010 };
    links[1].bounds = { top: 100, bottom: 160 };
    ui.window.events.scroll();
    ui.fireAnimationFrame();
    await settle();
    assert.equal(ui.calls.at(-1).options.headers["X-Notification-Visible-Ids"], "2");
    ui.ids.get("groups").querySelectorAll(".repo-toggle")[0].events.click();
    ui.fireAnimationFrame();
    await settle();
    assert.equal(ui.calls.at(-1).options.headers["X-Notification-Visible-Ids"], "");
    ui.ids.get("groups").querySelectorAll(".repo-toggle")[0].events.click();
    ui.window.innerHeight = 1100;
    ui.window.events.resize();
    ui.fireAnimationFrame();
    await settle();
    assert.equal(ui.calls.at(-1).options.headers["X-Notification-Visible-Ids"], "1,2");
  } finally {
    ui.window.events.pagehide();
  }
  assert.equal(ui.animationFrames.size, 0);
});

test("unchanged scroll and resize events measure loaded rows once, not once per tooltip", async () => {
  for (const count of [50, 100, 500]) {
    const ui = await renderer({ initialRows: Array.from({ length: count }, (_, index) => thread(String(index + 1))) });
    try {
      const links = ui.ids.get("groups").querySelectorAll(".row-link");
      links.forEach((link, index) => { link.bounds = { top: index * 60, bottom: index * 60 + 60 }; });
      ui.window.events.scroll();
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
        assert.equal(measurements, count, `${event} scans ${count} loaded rows exactly once`);
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

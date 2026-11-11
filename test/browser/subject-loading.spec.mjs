import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

function populate(canvas) {
  canvas.rows.splice(0, canvas.rows.length, ...[
    ["1", "example/zulu", "2026-01-01T22:30:00Z", "Other"],
    ["2", "example/alpha", "2026-01-02T01:30:00Z", "Keep"],
    ["3", "example/zulu", "2026-01-02T07:30:00Z", "Keep"],
    ["4", "example/alpha", "2026-01-03T08:30:00Z", "Keep"],
    ["5", "example/beta", "2026-01-01T12:00:00Z", "Other"],
  ].map(([id, repository, updated_at, title]) => thread(id, {
    repository: { full_name: repository }, updated_at,
    subject: { type: "Issue", title: `${title} synthetic issue ${id}`, url: `https://api.github.com/repos/${repository}/issues/${id}` },
  })));
}

for (const packaged of [false, true]) {
  test.describe(`ordered status loading (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged, timezoneId: "America/Los_Angeles" });

    for (const [groupBy, expected] of [
      ["repo", ["1", "3", "2", "4", "5"]],
      ["none", ["1", "2", "3", "4", "5"]],
      ["date", ["4", "1", "2", "3", "5"]],
    ]) {
      test(`${groupBy} view loads top to bottom and shows reduced-motion-safe initial spinners`, async ({ page, canvas }, testInfo) => {
        populate(canvas);
        await canvas.preferences.update({ groupBy });
        const calls = [];
        let release;
        let held = new Promise(resolve => { release = resolve; });
        canvas.setRequestHook(async args => {
          const id = args.at(-1).match(/\/issues\/(\d+)$/)?.[1];
          if (!id) return;
          calls.push(id);
          await held;
          return http({ state: "closed", state_reason: "completed" });
        });
        try {
          await page.goto(canvas.url);
          await expect(page.locator(".subject-loading")).toHaveCount(5);
          await expect(page.locator(".row .title")).toHaveText(expected.map(id => canvas.rows.find(row => row.id === id).subject.title));
          await expect.poll(() => calls.toSorted()).toEqual(expected.toSorted());
          const icon = page.locator(".subject-loading .subject-icon").first();
          await expect(icon).toHaveAttribute("aria-label", "Issue: Loading status");
          await expect(icon.locator("svg")).toHaveAttribute("width", "16");
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await expect(icon.locator("svg")).toHaveCSS("animation-name", "refresh-spin");
          await page.emulateMedia({ reducedMotion: "reduce" });
          await expect(icon.locator("svg")).toHaveCSS("animation-name", "none");
          expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
          if (groupBy === "repo") await page.screenshot({ path: testInfo.outputPath("initial-status-loading.png"), fullPage: true });
          release();
          await expect.poll(() => calls.toSorted()).toEqual(expected.toSorted());
          await expect(page.locator(".subject-loading")).toHaveCount(0);
          await expect(page.locator(".subject-closed")).toHaveCount(5);

          held = new Promise(resolve => { release = resolve; });
          await page.locator("#force-refresh").click();
          await expect.poll(() => calls.length).toBe(10);
          await expect(page.locator(".subject-loading")).toHaveCount(0);
          await expect(page.locator(".subject-closed")).toHaveCount(5);
          release();
          await expect.poll(() => calls.toSorted()).toEqual([...expected, ...expected].sort());
          expect(canvas.writes).toEqual([]);
          expect(canvas.deliveries).toEqual([]);
        } finally {
          release();
        }
      });
    }

    test("grouping and search changes reprioritize pending check runs without fetching excluded matches", async ({ page, canvas }) => {
      populate(canvas);
      for (const row of canvas.rows) {
        row.subject.type = "CheckSuite";
        row.subject.url = row.subject.url.replace("/issues/", "/actions/runs/");
      }
      const first = Array.from({ length: 20 }, (_, index) => thread(String(index + 101), {
        repository: { full_name: "example/first" },
        subject: { type: "CheckSuite", title: "Other synthetic check",
          url: `https://api.github.com/repos/example/first/actions/runs/${index + 101}` },
      }));
      canvas.rows.unshift(...first);
      const calls = [];
      let release;
      const held = new Promise(resolve => { release = resolve; });
      canvas.setRequestHook(async args => {
        const id = args.at(-1).match(/\/actions\/runs\/(\d+)$/)?.[1];
        if (!id) return;
        calls.push(id);
        if (calls.length <= 20) await held;
        return http({ status: "completed", conclusion: "success" });
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".subject-loading")).toHaveCount(25);
        await expect.poll(() => calls.toSorted()).toEqual(first.map(row => row.id).sort());
        await page.locator("#settings-toggle").click();
        await page.locator("#group-by").selectOption("none");
        await page.keyboard.press("Escape");
        await page.getByRole("searchbox").fill("Keep");
        await expect(page.locator(".row")).toHaveCount(3);
        await expect(page.locator(".row .title")).toHaveText(["2", "3", "4"].map(id => canvas.rows.find(row => row.id === id).subject.title));
        release();
        await expect.poll(() => calls.toSorted()).toEqual([...first.map(row => row.id), "2", "3", "4"].sort());
        await expect(page.locator(".subject-loading")).toHaveCount(0);
        await expect(page.locator(".subject-success")).toHaveCount(3);
        expect(canvas.writes).toEqual([]);
        expect(canvas.deliveries).toEqual([]);
      } finally {
        release();
      }
    });

    test("re-expanding a PR finishes its merge-queue check before an unrelated slow lookup completes", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, thread("1"), thread("2", {
        repository: { full_name: "example/tools" },
        subject: { type: "Issue", title: "Synthetic slow issue", url: "https://api.github.com/repos/example/tools/issues/2" },
      }));
      canvas.rows[0].mergeQueued = true;
      let releasePR;
      const heldPR = new Promise(resolve => { releasePR = resolve; });
      let releaseSlow;
      const heldSlow = new Promise(resolve => { releaseSlow = resolve; });
      canvas.setRequestHook(async args => {
        if (args.at(-1) === "/repos/example/widgets/pulls/42") await heldPR;
        if (args.at(-1) === "/repos/example/tools/issues/2") await heldSlow;
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".subject-loading")).toHaveCount(2);
        const collapsed = page.waitForResponse(response => {
          if (new URL(response.url()).pathname !== "/api/subjects") return false;
          const input = response.request().postDataJSON();
          return input.complete && input.positions.length === 1 && input.positions[0] === 1;
        });
        await page.locator('[data-focus-key="repo:example/widgets"]').click();
        await collapsed;
        releasePR();
        await expect(page.locator('[data-focus-key="thread:1"] .subject-open')).toHaveCount(1);
        expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(0);
        await page.locator('[data-focus-key="repo:example/widgets"]').click();
        await expect(page.locator('[data-focus-key="thread:1"] .subject-merge-queued')).toBeVisible();
        await expect(page.locator('[data-focus-key="thread:2"] .subject-loading')).toBeVisible();
        expect(canvas.requests.filter(path => path === "graphql")).toHaveLength(1);
        expect(canvas.requests.filter(path => path === "/repos/example/widgets/pulls/42")).toHaveLength(1);
        releaseSlow();
        await expect(page.locator(".subject-loading")).toHaveCount(0);
        expect(canvas.writes).toEqual([]);
      } finally {
        releasePR();
        releaseSlow();
      }
    });
  });
}

import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`viewport, freshness and focus (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const groupBy of ["repo", "none"]) {
      test(`${groupBy} grouping can load, refresh and triage without a browser time zone`, async ({ page, canvas }) => {
        canvas.rows.splice(2);
        await canvas.preferences.update({ groupBy });
        await page.addInitScript(() => {
          const original = Intl.DateTimeFormat.prototype.resolvedOptions;
          Intl.DateTimeFormat.prototype.resolvedOptions = function() {
            const options = original.call(this);
            delete options.timeZone;
            return options;
          };
        });
        const zones = [];
        page.on("request", request => {
          if (new URL(request.url()).pathname.startsWith("/api/")) zones.push(request.headers()["x-notification-time-zone"]);
        });
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(2);
        await page.locator("#force-refresh").click();
        await expect(page.locator("#notice")).toBeHidden();
        await page.locator('[data-focus-key="read:1"]').click();
        await expect.poll(() => canvas.writes).toEqual(["1"]);
        await page.locator('[data-focus-key="done:2"]').click();
        await expect.poll(() => canvas.writes).toEqual(["1", "2"]);
        await expect(page.locator(".row")).toHaveCount(1);
        expect(zones.length).toBeGreaterThan(0);
        expect(zones.every(zone => zone === undefined)).toBe(true);
        await expect(page.locator("#notice")).toBeHidden();
      });
    }

    test("scroll and resize events do not measure loaded rows for status", async ({ page, canvas }) => {
      const viewportReady = page.waitForResponse(response => new URL(response.url()).pathname === "/api/state");
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(50);
      await viewportReady;
      const results = await page.evaluate(async () => {
        const links = [...document.querySelectorAll(".row-link")];
        const originals = links.map(link => link.getBoundingClientRect);
        let measurements = 0;
        links.forEach((link, index) => {
          link.getBoundingClientRect = function() { measurements++; return originals[index].call(this); };
        });
        try {
          const results = [];
          for (const event of ["scroll", "resize"]) {
            measurements = 0;
            window.dispatchEvent(new Event(event));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            results.push({ event, measurements });
          }
          return results;
        } finally {
          links.forEach((link, index) => { link.getBoundingClientRect = originals[index]; });
        }
      });
      expect(results).toEqual([{ event: "scroll", measurements: 0 }, { event: "resize", measurements: 0 }]);
      expect(canvas.writes).toEqual([]);
    });

    for (const groupBy of ["repo", "none", "date"]) {
      test(`${groupBy} loads all expanded statuses without scrolling, including loaded pages and force refresh`, async ({ page, canvas }) => {
        canvas.rows.splice(0, canvas.rows.length, ...Array.from({ length: 60 }, (_, index) => thread(String(index + 1), {
          subject: { type: "Issue", title: `Synthetic expanded issue ${index + 1}`,
            url: `https://api.github.com/repos/example/widgets/issues/${index + 1}` },
          subjectDetails: { state: "closed" },
        })));
        await canvas.preferences.update({ groupBy });
        const requested = () => canvas.requests.filter(path => /\/issues\/\d+$/.test(path));
        await page.setViewportSize({ width: 640, height: 600 });
        await page.goto(canvas.url);
        await expect(page.locator(".subject-closed")).toHaveCount(50);
        expect(requested().sort()).toEqual(canvas.rows.slice(0, 50).map((_, index) => `/repos/example/widgets/issues/${index + 1}`).sort());
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(await page.locator('[data-focus-key="thread:50"]').evaluate(node =>
          node.getBoundingClientRect().top > window.innerHeight)).toBe(true);

        await page.locator("#more").click();
        await expect(page.locator(".subject-closed")).toHaveCount(60);
        expect(requested()).toHaveLength(60);
        await page.locator("#collapse").click();
        await expect(page.locator(".repo-items")).toBeHidden();
        await page.locator("#force-refresh").click();
        await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator(".repo-items")).toBeHidden();
        await expect.poll(() => requested().length).toBe(120);
        await page.locator("#collapse").click();
        expect(requested()).toHaveLength(120, "Expanding reuses the details fetched for authorship");
        await expect(page.locator(".subject-loading")).toHaveCount(0);
        expect(canvas.writes).toEqual([]);
      });
    }

    test("collapsing a group drops its pending off-screen check statuses until expanded", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, ...Array.from({ length: 40 }, (_, index) => {
        const repository = index < 20 ? "example/widgets" : "example/tools";
        return thread(String(index + 1), {
          repository: { full_name: repository },
          subject: { type: "CheckSuite", title: `Synthetic expanded check ${index + 1}`,
            url: `https://api.github.com/repos/${repository}/actions/runs/${index + 1}` },
          subjectDetails: { status: "completed", conclusion: "success" },
        });
      }));
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const requested = () => canvas.requests.filter(path => /\/actions\/runs\/\d+$/.test(path));
      canvas.setRequestHook(async args => {
        if (args.at(-1).startsWith("/repos/example/widgets/actions/runs/")) await held;
      });
      try {
        await page.goto(canvas.url);
        await expect(page.locator(".subject-loading")).toHaveCount(40);
        await expect.poll(() => requested().sort()).toEqual(Array.from({ length: 20 }, (_, index) => `/repos/example/widgets/actions/runs/${index + 1}`).sort());
        const selected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/subjects" &&
          response.request().postDataJSON().complete && response.request().postDataJSON().positions.length === 20);
        await page.getByRole("button", { name: /example\/tools.*total/ }).click();
        await selected;
        release();
        await expect(page.locator(".subject-success")).toHaveCount(20);
        await expect(page.locator(".subject-loading:visible")).toHaveCount(0);
        expect(requested()).toHaveLength(20);
        await page.getByRole("button", { name: /example\/tools.*total/ }).click();
        await expect(page.locator(".subject-success")).toHaveCount(40);
        expect(requested()).toHaveLength(40);
        expect(canvas.writes).toEqual([]);
      } finally {
        release();
      }
    });

    test("freshness describes cached failures without replacing the last known icon", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].subject = {
        type: "PullRequest", title: "Synthetic cached result",
        url: "https://api.github.com/repos/example/widgets/pulls/42",
      };
      canvas.rows[0].subjectDetails = { state: "closed", merged: true, draft: false };
      await page.clock.install();
      await page.goto(canvas.url);
      const icon = page.locator(".subject-icon");
      await expect(icon).toHaveAttribute("aria-label", /Pull Request: Merged\. Checked just now/);
      await icon.hover();
      expect(await icon.evaluate(node => node.closest("[title]") === null)).toBe(true);
      await page.clock.fastForward(120_000);
      await expect(icon).toHaveAttribute("aria-label", /Pull Request: Merged\. Checked 2 minutes ago/);
      await expect(icon).not.toHaveAttribute("title");
      canvas.setRequestHook(args => args.at(-1).endsWith("/pulls/42") ? http({}, {}, 503) : undefined);
      await page.locator("#force-refresh").click();
      await expect(icon).toHaveAttribute("aria-label", /Pull Request: Merged\. Cached result; refresh failed\./);
      await expect(icon).toHaveAttribute("aria-label", /Checked 2 minutes ago$/);
      await expect(icon).not.toHaveAttribute("title");
      await expect(page.locator(".subject-merged")).toHaveCount(1);
      await expect(page.locator(".subject-loading")).toHaveCount(0);
    });

    test("check-suite rows use verified run results and keep the selected fallback for missing links", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length,
        thread("1", { subject: { type: "CheckSuite", title: "Synthetic suite", url: "https://api.github.com/repos/example/widgets/check-suites/7" },
          subjectDetails: { status: "completed", conclusion: "failure" },
          workflowRunResults: { total_count: 1, workflow_runs: [
            { id: 123, check_suite_id: 7, html_url: "https://github.com/example/widgets/actions/runs/123" },
          ] } }),
        thread("2", { subject: { type: "CheckSuite", title: "Synthetic build workflow run failed for main", url: null } }),
        thread("3", { subject: { type: "CheckSuite", title: "Synthetic direct run", url: "https://api.github.com/repos/example/widgets/actions/runs/124" } }));
      await page.goto(canvas.url);
      const first = page.locator('[data-focus-key="thread:1"]');
      await expect(first).toHaveAttribute("href", "https://github.com/example/widgets/actions/runs/123");
      await expect(page.locator('[data-focus-key="thread:2"]')).toHaveAttribute("href", "https://github.com/example/widgets/actions");
      await expect(page.locator('[data-focus-key="thread:2"] .destination')).toHaveCount(0);
      await expect(page.locator('[data-focus-key="thread:2"]')).toHaveAccessibleName(/Open repository Actions/);
      await expect(page.locator('[data-focus-key="thread:3"]')).toHaveAttribute("href", "https://github.com/example/widgets/actions/runs/124");
      await page.evaluate(() => {
        document.addEventListener("click", event => {
          const link = event.target.closest(".row-link");
          if (link) {
            event.preventDefault();
            window.clickedRunURL = link.href;
          }
        });
      });
      await first.locator(".title").click();
      expect(await page.evaluate(() => window.clickedRunURL)).toBe("https://github.com/example/widgets/actions/runs/123");
      expect(canvas.writes).toEqual([]);
    });

    test("hiding an empty tab cannot steal focus from the host composer", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      canvas.rows[0].reason = "mention";
      const host = new URL("/synthetic-host", canvas.url).href;
      await page.route(host, route => route.fulfill({
        contentType: "text/html",
        body: `<html lang="en"><title>Synthetic Copilot host</title><body>
          <label>Copilot composer<input id="composer"></label>
          <iframe title="Notifications" src="${canvas.url}" style="width:960px;height:720px"></iframe>
        </body></html>`,
      }));
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.goto(host);
      const frame = page.frameLocator("iframe");
      const mentioned = frame.getByRole("tab", { name: "Mentioned (1)", exact: true });
      await expect(mentioned).toHaveAttribute("aria-selected", "false");
      await mentioned.focus();
      const composer = page.getByRole("textbox", { name: "Copilot composer" });
      await composer.fill("Continue typing in Copilot");
      canvas.rows[0].reason = "subscribed";
      const status = await frame.locator("body").evaluate(async () => {
        const response = await fetch("/api/refresh", {
          method: "POST",
          headers: { Authorization: `Bearer ${location.hash.slice(1)}`, "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        return response.status;
      });
      expect(status).toBe(200);
      await page.clock.runFor(5000);
      await expect(frame.locator("#attention-mentioned")).toBeHidden();
      await expect(frame.getByRole("tab", { name: "All (1)", exact: true })).toHaveAttribute("tabindex", "0");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("Continue typing in Copilot");
      expect(await frame.locator("body").evaluate(() => document.hasFocus())).toBe(false);
      expect(canvas.writes).toEqual([]);
    });

    for (const manual of [false, true]) {
      test(`${manual ? "manual" : "automatic"} refresh cannot steal focus from the host composer`, async ({ page, canvas }) => {
        canvas.rows.splice(1);
        canvas.rows[0].subject.title = "Initial synthetic notification";
        const host = new URL("/synthetic-host", canvas.url).href;
        await page.route(host, route => route.fulfill({
          contentType: "text/html",
          body: `<html lang="en"><title>Synthetic Copilot host</title><body>
            <label>Copilot composer<input id="composer"></label>
            <iframe title="Notifications" src="${canvas.url}" style="width:960px;height:720px"></iframe>
          </body></html>`,
        }));
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let holdRefresh = false;
        let started = false;
        canvas.setRequestHook(async args => {
          if (holdRefresh && args.at(-1).startsWith("/notifications?")) {
            started = true;
            await held;
          }
        });
        try {
          if (!manual) {
            await page.clock.install();
            await page.clock.pauseAt(new Date(Date.now() + 1000));
          }
          await page.goto(host);
          const frame = page.frameLocator("iframe");
          const composer = page.getByRole("textbox", { name: "Copilot composer" });
          await expect(frame.locator(".row .title")).toHaveText("Initial synthetic notification");
          await frame.locator(".row-link").focus();
          canvas.rows[0].subject.title = "Updated synthetic notification";
          if (manual) {
            holdRefresh = true;
            await frame.locator("#force-refresh").click();
            await expect.poll(() => started).toBe(true);
            await composer.fill("Continue typing in Copilot");
            release();
          } else {
            await composer.fill("Continue typing in Copilot");
            const status = await frame.locator("body").evaluate(async () => {
              const response = await fetch("/api/refresh", {
                method: "POST",
                headers: { Authorization: `Bearer ${location.hash.slice(1)}`, "Content-Type": "application/json" },
                body: JSON.stringify({ force: true }),
              });
              return response.status;
            });
            expect(status).toBe(200);
            await page.clock.runFor(5000);
          }
          await expect(frame.locator(".row .title")).toHaveText("Updated synthetic notification");
          await expect(composer).toBeFocused();
          await expect(composer).toHaveValue("Continue typing in Copilot");
          expect(await frame.locator("body").evaluate(() => document.hasFocus())).toBe(false);
          expect(canvas.writes).toEqual([]);
        } finally {
          release();
        }
      });
    }
  });
}

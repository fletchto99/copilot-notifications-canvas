import { test, expect } from "./fixtures.mjs";
import { thread } from "../fixtures.mjs";

for (const packaged of [false, true]) {
  test.describe(`large status selections (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("650 loaded rows resolve through bounded chunks while refresh and triage stay usable", async ({ page, canvas }) => {
      test.setTimeout(60_000);
      canvas.rows.splice(0, canvas.rows.length, ...Array.from({ length: 650 }, (_, index) =>
        thread(String(1000000000000 + index), {
          subject: { type: "Issue", title: `Synthetic large inbox issue ${index + 1}`,
            url: `https://api.github.com/repos/example/widgets/issues/${index + 1}` },
          subjectDetails: { state: "closed" },
        })));
      const requests = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request);
      });
      await page.goto(canvas.url);
      for (let count = 50; count <= 650; count += 50) {
        await expect(page.locator(".row")).toHaveCount(count);
        await expect(page.locator("#notice")).toBeHidden();
        await expect.poll(() => requests.filter(request =>
          new URL(request.url()).pathname === "/api/subjects" &&
          request.postDataJSON().complete &&
          request.postDataJSON().offset + request.postDataJSON().positions.length === count).length).toBeGreaterThan(0);
        if (count < 650) await page.locator("#more").click();
      }
      await expect(page.locator(".subject-closed")).toHaveCount(650);
      expect(canvas.rows.map(row => row.id).join(",").length).toBeGreaterThan(8192);
      for (const request of requests) {
        expect(request.headers()["x-notification-visible-ids"]).toBeUndefined();
        if (new URL(request.url()).pathname !== "/api/subjects") continue;
        const body = request.postDataJSON();
        expect(body.positions.length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(request.postData())).toBeLessThanOrEqual(4096);
      }
      await page.locator("#force-refresh").click();
      await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
      await page.locator('[data-focus-key="read:1000000000000"]').click();
      await expect.poll(() => canvas.writes).toEqual(["1000000000000"]);
      await page.locator('[data-focus-key="done:1000000000001"]').click();
      await expect.poll(() => canvas.writes).toEqual(["1000000000000", "1000000000001"]);
      await expect(page.locator(".row")).toHaveCount(649);
      await expect(page.locator("#notice")).toBeHidden();
      expect(canvas.deliveries).toEqual([]);
    });

    test("a failed selection upload reports its error without disabling refresh or Done", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      let failed = false;
      await page.route("**/api/subjects", async route => {
        if (!failed) {
          failed = true;
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({
            error: { message: "Synthetic status selection failure" },
          }), status: 503 });
        }
        await route.continue();
      });
      canvas.expectConsoleError("/api/subjects", "Failed to load resource: the server responded with a status of 503 (Service Unavailable)");
      await page.goto(canvas.url);
      await expect(page.locator("#notice")).toContainText("Notification status loading paused.");
      await expect(page.locator("#notice")).toContainText("Synthetic status selection failure");
      await page.locator("#force-refresh").click();
      await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
      await page.locator('[data-focus-key="done:1"]').click();
      await expect.poll(() => canvas.writes).toEqual(["1"]);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#notice")).toBeHidden({ timeout: 15_000 });
    });

    test("Read and Done during a delayed chunk restart status selection without an outage", async ({ page, canvas }) => {
      canvas.rows.splice(0, canvas.rows.length, ...Array.from({ length: 150 }, (_, index) =>
        thread(String(index + 1), {
          subject: { type: "Issue", title: `Synthetic overlapping issue ${index + 1}`,
            url: `https://api.github.com/repos/example/widgets/issues/${index + 1}` },
          subjectDetails: { state: "closed" },
        })));
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let staleKey;
      const responses = [];
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/subjects") responses.push(response);
      });
      await page.route("**/api/subjects", async route => {
        const input = route.request().postDataJSON();
        if (input.offset === 100 && !staleKey) {
          staleKey = input.selectionKey;
          await held;
        }
        await route.continue();
      });
      try {
        await page.goto(canvas.url);
        for (const count of [50, 100]) {
          await expect(page.locator(".subject-closed")).toHaveCount(count);
          await page.locator("#more").click();
        }
        await expect(page.locator(".row")).toHaveCount(150);
        await expect.poll(() => staleKey).toBeTruthy();
        await page.locator('[data-focus-key="read:1"]').click();
        await expect.poll(() => canvas.writes).toEqual(["1"]);
        await page.locator('[data-focus-key="done:2"]').click();
        await expect.poll(() => canvas.writes).toEqual(["1", "2"]);
        await expect(page.locator(".row")).toHaveCount(149);

        const staleResponse = page.waitForResponse(response => {
          if (new URL(response.url()).pathname !== "/api/subjects") return false;
          const input = response.request().postDataJSON();
          return input.selectionKey === staleKey && input.offset === 100;
        });
        release();
        const stale = await staleResponse;
        expect(stale.status()).toBe(200);
        expect((await stale.json()).status).toBe("stale");
        await expect.poll(async () => {
          const fresh = responses.find(response => {
            const input = response.request().postDataJSON();
            return input.selectionKey !== staleKey && input.complete && input.offset + input.positions.length === 149;
          });
          return fresh ? (await fresh.json()).status : undefined;
        }).toBe("complete");
        await expect(page.locator(".subject-closed")).toHaveCount(149);
        await expect(page.locator("#notice")).toBeHidden();
        expect(canvas.deliveries).toEqual([]);
      } finally {
        release();
      }
    });
  });
}

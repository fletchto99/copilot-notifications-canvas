import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";
import { readFile, writeFile } from "node:fs/promises";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

for (const packaged of [false, true]) {
  test.describe(`settings recovery (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    test("bad settings warn while a closed Settings panel still permits refreshing and filtering", async ({ page, canvas }) => {
      canvas.rows.splice(3);
      canvas.rows[1].unread = false;
      await canvas.preferences.update({ matchGitHubInbox: false });
      const valid = await readFile(canvas.preferences.path, "utf8");
      await page.clock.install();
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#show-notifications")).toHaveValue("unread");
      const invalid = '{"matchGitHubInbox":false,"autoOpen":"yes"}';
      await writeFile(canvas.preferences.path, invalid);
      const error = await canvas.preferences.read().catch(error => error);
      expect(error.code).toBe("settings_read");
      canvas.expectProviderError(error.message);
      await page.clock.runFor(5000);
      await expect(page.locator("#settings")).not.toHaveAttribute("open");
      await expect(page.locator("#settings-error")).toContainText("Could not read notification settings");
      await expect(page.locator("#notice")).toBeHidden();
      canvas.rows.push(thread("4", { subject: { title: "Arrived while settings were invalid", type: "Issue", url: null } }));
      await page.locator("#force-refresh").click();
      await expect(page.locator(".row")).toHaveCount(3);
      await expect(page.locator(".row.read")).toHaveCount(0);
      await page.getByRole("searchbox").fill("Arrived");
      await page.clock.runFor(250);
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator("#settings-error")).toBeVisible();
      expect(await readFile(canvas.preferences.path, "utf8")).toBe(invalid);
      await writeFile(canvas.preferences.path, valid);
      await page.clock.runFor(5000);
      await expect(page.locator("#settings-error")).toBeHidden();
      await expect(page.getByRole("searchbox")).toHaveValue("Arrived");
      await expect(page.locator(".row")).toHaveCount(1);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });

    test("a first inbox load can use defaults with an explicit settings warning", async ({ page, canvas }) => {
      canvas.rows.splice(2);
      canvas.rows[1].unread = false;
      await canvas.preferences.update({ matchGitHubInbox: false });
      const valid = await readFile(canvas.preferences.path, "utf8");
      await writeFile(canvas.preferences.path, "{");
      const error = await canvas.preferences.read().catch(error => error);
      expect(error.code).toBe("settings_read");
      canvas.expectProviderError(error.message);
      let failedSettingsReads = 0;
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/settings" && response.status() === 500) {
          failedSettingsReads++;
          canvas.expectConsoleError("/api/settings", "Failed to load resource: the server responded with a status of 500 (Internal Server Error)");
        }
      });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(2);
      await expect(page.locator("#settings-error")).toContainText("Could not read notification settings");
      await expect(page.locator("#notice")).toBeHidden();
      await expect(page.locator(".row.read")).toHaveCount(1);
      expect(failedSettingsReads).toBeGreaterThan(0);
      expect(await readFile(canvas.preferences.path, "utf8")).toBe("{");
      await writeFile(canvas.preferences.path, valid);
      await page.locator("#settings-toggle").click();
      await expect(page.locator("#show-notifications")).toHaveValue("unread");
      await expect(page.locator("#settings-error")).toBeHidden();
      await page.keyboard.press("Escape");
      await page.locator("#force-refresh").click();
      await expect(page.locator(".row")).toHaveCount(1);
      await expect(page.locator(".row.read")).toHaveCount(0);
      expect(canvas.writes).toEqual([]);
      expect(canvas.deliveries).toEqual([]);
    });
  });
}

test("a delayed refresh survives hiding and showing the document without losing search", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByRole("searchbox").fill("Needle");
  await expect(page.locator(".row")).toHaveCount(3);
  const held = gate();
  const entered = gate();
  canvas.setRequestHook(async args => {
    if (args.includes("GET") && args.at(-1).startsWith("/notifications")) {
      entered.release();
      await held.promise;
    }
  });
  try {
    await page.getByRole("button", { name: "Force refresh", exact: true }).click();
    await entered.promise;
    const aborted = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/refresh"));
    await page.evaluate(() => { document.documentElement.style.display = "none"; });
    await aborted;
    canvas.rows[0].subject.title = "Needle after delayed refresh";
    canvas.setRequestHook(undefined);
    held.release();
    await page.evaluate(() => { document.documentElement.style.display = ""; });
    await expect(page.getByRole("searchbox")).toHaveValue("Needle");
    await expect(page.getByRole("link", { name: "Needle after delayed refresh" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".row")).toHaveCount(3);
    await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#notice")).toBeHidden();
    expect(canvas.writes).toEqual([]);
  } finally {
    held.release();
  }
});

for (const action of ["read", "done"]) {
  test(`changed local polls do not steal focus from pending ${action} actions`, async ({ page, canvas }) => {
    canvas.rows.splice(2);
    await page.clock.install();
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator("#group-by")).toBeEnabled();
    const held = gate();
    const entered = gate();
    await page.route("**/api/state", async route => {
      const response = await route.fetch();
      const state = await response.json();
      state.groups[0].items[0].title = "Changed during status polling";
      entered.release();
      await held.promise;
      await route.fulfill({ response, json: state });
    }, { times: 1 });
    try {
      await page.clock.fastForward(5000);
      await entered.promise;
      const button = page.locator(`[data-focus-key="${action}:1"]`);
      await button.focus();
      await button.press("Enter");
      await expect(button).toBeDisabled();
      expect(canvas.writes).toEqual([]);
      held.release();
      await expect(page.locator(".row")).toHaveCount(action === "read" ? 2 : 1);
      await expect(page.locator(`[data-focus-key="${action === "read" ? "done:1" : "done:2"}"]`)).toBeFocused();
      expect(canvas.writes).toEqual(["1"]);
      expect(canvas.doneWrites).toEqual(action === "done" ? ["1"] : []);
    } finally {
      held.release();
    }
  });
}

test("Done waits for confirmation, reports failures, and never retries automatically", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.clock.install();
  await page.goto(canvas.url);
  const done = page.locator('[data-focus-key="done:1"]');
  await expect(done).toBeEnabled();
  const held = gate();
  const entered = gate();
  let attempts = 0;
  canvas.setRequestHook(async args => {
    if (!args.includes("DELETE")) return;
    attempts++;
    entered.release();
    await held.promise;
    return http({}, {}, 500);
  });
  try {
    await done.focus();
    await done.press("Enter");
    await entered.promise;
    await expect(done).toBeDisabled();
    await expect(done).toHaveText("");
    await expect(done).toHaveAttribute("aria-busy", "true");
    await expect(done.locator("svg")).toHaveCount(1);
    await expect(done.locator("svg")).toBeHidden();
    await expect(done).toHaveAttribute("data-write-state", "queued");
    expect(await done.evaluate(node => getComputedStyle(node, "::after").animationName)).toBe("none");
    await page.clock.fastForward(1000);
    await expect(done).toHaveAttribute("data-write-state", "active");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await done.evaluate(node => getComputedStyle(node, "::after").animationName)).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await done.evaluate(node => getComputedStyle(node, "::after").animationName)).toBe("refresh-spin");
    await expect(page.locator('[data-focus-key="read:1"]')).toBeDisabled();
    await expect(page.locator(".repo-read")).toBeDisabled();
    await expect(page.locator(".row")).toHaveCount(2);
    held.release();
    await page.clock.fastForward(1000);
    await expect(page.locator("#notice")).toContainText("Could not mark the notification as done");
    await expect(done).toBeEnabled();
    await expect(done).toHaveAttribute("aria-busy", "false");
    await expect(done.locator("svg")).toBeVisible();
    await expect(done).toBeFocused();
    expect(canvas.writes).toEqual([]);
    await page.clock.fastForward(5000);
    expect(attempts).toBe(1);
    canvas.advance(120_000);
    canvas.setRequestHook(undefined);
    await done.press("Enter");
    await page.clock.fastForward(1000);
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator("#notice")).toBeHidden();
    expect(canvas.doneWrites).toEqual(["1"]);
  } finally {
    held.release();
  }
});

test("queued row acknowledgements survive more than the action request deadline and retain later errors", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  const first = gate();
  const second = gate();
  const enteredSecond = gate();
  canvas.setRequestHook(async args => {
    if (!args.includes("DELETE")) return;
    if (args.at(-1).endsWith("/threads/1")) await first.promise;
    else {
      enteredSecond.release();
      await second.promise;
      return http({}, {}, 500);
    }
  });
  await page.clock.install();
  await page.goto(canvas.url);
  try {
    for (const id of ["1", "2"]) {
      const acknowledgement = page.waitForResponse(response => response.url().endsWith("/api/done"));
      await page.locator(`[data-focus-key="done:${id}"]`).click();
      const response = await acknowledgement;
      expect(response.status()).toBe(202);
      expect((await response.json()).rowActionToken).toMatch(/^[a-f0-9-]{36}$/);
    }
    await page.clock.fastForward(29_000);
    await expect(page.locator('[data-focus-key="done:2"]')).toHaveAttribute("data-write-state", "queued");
    first.release();
    await enteredSecond.promise;
    await page.clock.fastForward(29_000);
    await expect(page.locator('[data-focus-key="done:1"]')).toHaveCount(0);
    await expect(page.locator('[data-focus-key="done:2"]')).toHaveAttribute("data-write-state", "active");
    await expect(page.locator("#notice")).toBeHidden();
    second.release();
    await page.clock.fastForward(1000);
    await expect(page.locator("#notice")).toContainText("Could not mark the notification as done");
    await expect(page.locator("#notice")).toContainText("HTTP 500");
    await expect(page.locator('[data-focus-key="done:2"]')).toBeEnabled();
    expect(canvas.doneWrites).toEqual(["1"]);
  } finally {
    first.release();
    second.release();
  }
});

for (const moveFocus of [false, true]) {
  test(`shortcut completion polls preserve next-row focus before acknowledgement (${moveFocus ? "new focus" : "advance"})`, async ({ page, canvas }) => {
    canvas.rows.splice(3);
    const acknowledgement = gate();
    const queued = gate();
    await page.route("**/api/done", async route => {
      const response = await route.fetch();
      queued.release();
      await acknowledgement.promise;
      await route.fulfill({ response });
    });
    await page.goto(canvas.url);
    try {
      await page.locator('[data-focus-key="thread:1"]').focus();
      await page.keyboard.press("Shift+KeyE");
      await queued.promise;
      if (moveFocus) await page.getByRole("searchbox").focus();
      await expect(page.locator('[data-focus-key="thread:1"]')).toHaveCount(0);
      const expected = moveFocus ? page.getByRole("searchbox") : page.locator('[data-focus-key="thread:2"]');
      await expect(expected).toBeFocused();
      const received = page.waitForResponse(response => response.url().endsWith("/api/done"));
      acknowledgement.release();
      await received;
      await expect(expected).toBeFocused();
      expect(canvas.doneWrites).toEqual(["1"]);
    } finally {
      acknowledgement.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("a read batch has no Stop control and completes every selected row", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  const held = gate();
  const entered = gate();
  canvas.setRequestHook(async args => {
    if (args.includes("PATCH")) { entered.release(); await held.promise; }
  });
  try {
    await page.getByRole("button", { name: "Mark 2 as read in example/widgets; 2 shown, loaded notifications", exact: true }).click();
    await entered.promise;
    await expect(page.getByRole("button", { name: "Stop remaining", exact: true })).toHaveCount(0);
    await expect(page.locator("#batch-progress")).toBeHidden();
    await expect(page.locator(".repo-read")).toBeFocused();
    canvas.setRequestHook(undefined);
    held.release();
    await expect(page.locator(".row.unread")).toHaveCount(0);
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator("#batch-progress")).toBeHidden();
    expect(canvas.writes).toEqual(["1", "2"]);
  } finally {
    held.release();
  }
});

test("failed batches keep rows and recover after the retry deadline without widening selection", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  canvas.setRequestHook(args => args.includes("PATCH") ? http({}, {}, 500) : undefined);
  await page.getByRole("button", { name: "Mark 2 as read in example/widgets; 2 shown, loaded notifications", exact: true }).click();
  await expect(page.locator("#batch-error")).toContainText("GitHub returned HTTP 500");
  await expect(page.locator(".row")).toHaveCount(2);
  expect(canvas.writes).toEqual([]);
  const retry = page.getByRole("button", { name: "Retry remaining (2)", exact: true });
  await expect(retry).toBeDisabled();
  canvas.setRequestHook(undefined);
  canvas.rows.push(thread("3"));
  await page.clock.setFixedTime(new Date(canvas.advance(121_000)));
  await expect(page.locator(".row")).toHaveCount(3, { timeout: 10_000 });
  await expect(retry).toBeEnabled({ timeout: 10_000 });
  await retry.click();
  await expect(page.locator(".row.unread")).toHaveCount(1);
  await expect(page.locator(".row")).toHaveCount(3);
  expect(canvas.writes).toEqual(["1", "2"]);
  await expect(page.getByRole("link", { name: /^Synthetic notification 3 / })).toBeVisible();
});

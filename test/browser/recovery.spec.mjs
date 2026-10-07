import { test, expect } from "./fixtures.mjs";
import { http, thread } from "../fixtures.mjs";

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
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
    await expect(page.getByRole("link", { name: "Needle after delayed refresh", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".row")).toHaveCount(3);
    await expect(page.locator("#force-refresh")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#notice")).toBeHidden();
    expect(canvas.writes).toEqual([]);
  } finally {
    held.release();
  }
});

test("changed local polls do not steal focus from pending row reads", async ({ page, canvas }) => {
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
    const button = page.locator('[data-thread-id="1"]');
    await button.focus();
    await button.press("Enter");
    await expect(button).toBeDisabled();
    expect(canvas.writes).toEqual([]);
    held.release();
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator('[data-thread-id="2"]')).toBeFocused();
    expect(canvas.writes).toEqual(["1"]);
  } finally {
    held.release();
  }
});

test("batch cancellation waits for the in-flight write and retry writes only remaining rows", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(2);
  const held = gate();
  const entered = gate();
  canvas.setRequestHook(async args => {
    if (args.includes("PATCH")) { entered.release(); await held.promise; }
  });
  try {
    await page.getByRole("button", { name: "Mark 2 shown, loaded notifications as read in example/widgets", exact: true }).click();
    await entered.promise;
    await page.getByRole("button", { name: "Stop remaining", exact: true }).click();
    await expect(page.locator("#batch-title")).toContainText("Stopping");
    canvas.setRequestHook(undefined);
    held.release();
    await expect(page.getByRole("button", { name: "Retry remaining (1)", exact: true })).toBeVisible();
    expect(canvas.writes).toEqual(["1"]);
    await page.getByRole("button", { name: "Retry remaining (1)", exact: true }).click();
    await expect(page.locator(".row")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Mark 2 shown, loaded notifications as read in example/widgets", exact: true }).click();
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
  await expect(page.locator(".row")).toHaveCount(1);
  expect(canvas.writes).toEqual(["1", "2"]);
  await expect(page.getByRole("link", { name: "Synthetic notification 3", exact: true })).toBeVisible();
});

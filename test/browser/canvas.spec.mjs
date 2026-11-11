import AxeBuilder from "@axe-core/playwright";
import { test, expect, openSettings } from "./fixtures.mjs";
import { CURRENT_VERSION } from "../../src/provider/updates.mjs";

const searchName = "Search loaded notification titles, issue or PR numbers, and repositories";

async function focusToolbarWithKeyboard(page, selector) {
  await page.getByRole("searchbox").focus();
  for (const target of ["#settings-toggle", "#shortcuts-toggle", "#force-refresh", "#open-inbox"]) {
    await page.keyboard.press("Shift+Tab");
    if (target === selector) break;
  }
  await expect(page.locator(selector)).toBeFocused();
}

for (const packaged of [false, true]) {
  test.describe(`passive tab updates (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });
    for (const [label, reason, hiddenSide] of [
      ["Assigned", "assign", "left"],
      ["Review Requested", "review_requested", "right"],
    ]) {
      test(`preserve page scroll and reveal a focused tab hidden to the ${hiddenSide}`, async ({ page, canvas }) => {
        await canvas.preferences.update({ hideEmptyTabs: false });
        canvas.rows.splice(50);
        for (const row of canvas.rows) row.reason = reason;
        await page.setViewportSize({ width: 320, height: 640 });
        await page.clock.install();
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(50);
        const tab = page.getByRole("tab", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await tab.focus();
        await page.locator("#attention-tabs").evaluate((node, side) => {
          node.scrollLeft = side === "left" ? node.scrollWidth : 0;
        }, hiddenSide);
        await page.evaluate(() => window.scrollTo(0, 900));
        const unchanged = page.waitForResponse(response => response.url().endsWith("/api/state"));
        await page.clock.fastForward(5000);
        await unchanged;
        expect(await page.evaluate(() => scrollY)).toBe(900);

        const url = new URL(canvas.url);
        const done = await page.request.post(new URL("/api/done", url).href, {
          headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin },
          data: { id: "1" },
        });
        expect(done.status()).toBe(202);
        await page.clock.fastForward(5000);
        await expect(tab).toHaveText(`${label} (49)`);
        await expect(page.locator(".row")).toHaveCount(49);
        expect(await page.evaluate(() => scrollY)).toBe(900);
        await expect(tab).toBeFocused();
        const bounds = await tab.evaluate(node => {
          const tab = node.getBoundingClientRect();
          const strip = node.parentElement.getBoundingClientRect();
          return { left: tab.left, right: tab.right, stripLeft: strip.left, stripRight: strip.right };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(bounds.stripLeft);
        expect(bounds.right).toBeLessThanOrEqual(bounds.stripRight);
        expect(canvas.writes).toEqual(["1"]);
      });
    }
  });
}

for (const packaged of [false, true]) {
  test.describe(`compact header (${packaged ? "packaged" : "source"})`, () => {
    test.use({ packaged });

    for (const font of ["default", "Arial"]) {
      test(`keeps the full title readable and utility buttons aligned with ${font} fonts`, async ({ page, canvas }, testInfo) => {
        canvas.rows.splice(1);
        await page.goto(canvas.url);
        await expect(page.locator(".row")).toHaveCount(1);
        if (font === "Arial") await page.addStyleTag({ content: ":root { --font-sans: Arial, sans-serif; }" });
        const title = page.getByRole("heading", { name: "GitHub Notifications", exact: true });
        await expect(page.locator(".eyebrow, #subtitle")).toHaveCount(0);
        const initialHeight = (await page.locator("header").boundingBox()).height;
        expect(initialHeight).toBeLessThanOrEqual(185);
        for (const width of [480, 320, 360, 361, 400, 481, 960]) {
          await page.setViewportSize({ width, height: 800 });
          const stacked = width <= 360;
          const gap = stacked ? 4 : 8;
          await expect(title).toHaveCSS("font-size", "24px");
          await expect(title).toHaveCSS("line-height", "30px");
          const heading = await title.boundingBox();
          expect([30, 38, 60]).toContain(heading.height);
          if (stacked) expect(heading.height).toBe(30);
          else if (width >= 480) expect(heading.height).toBe(38);
          const toolbar = await page.locator(".toolbar").boundingBox();
          expect(toolbar.height).toBe(heading.height + (stacked ? 42 : 0));
          if (stacked) expect(heading.width).toBe(width - 24);
          let previousRight = stacked ? heading.x - gap : heading.x + heading.width;
          for (const selector of ["#open-inbox", "#force-refresh", "#shortcuts-toggle", "#settings-toggle"]) {
            const button = await page.locator(selector).boundingBox();
            expect(button.width).toBe(38);
            expect(button.height).toBe(38);
            expect(button.y + button.height / 2).toBe(stacked ? heading.y + heading.height + 23 : heading.y + heading.height / 2);
            expect(button.x).toBeGreaterThanOrEqual(previousRight + gap);
            previousRight = button.x + button.width;
          }
          expect(previousRight).toBe(width - 12);
          const search = await page.getByRole("searchbox").boundingBox();
          const filters = await page.locator("#filters-toggle").boundingBox();
          const tabs = await page.locator(".attention-navigation").boundingBox();
          expect(search.width + filters.width + 8).toBeCloseTo(width - 24, 1);
          expect(filters.x).toBeCloseTo(search.x + search.width + 8, 1);
          expect(filters.y).toBe(search.y);
          expect(filters.height).toBe(search.height);
          expect(search.height).toBe(38);
          expect(search.y).toBe(toolbar.y + toolbar.height + 8);
          expect(tabs.y).toBe(search.y + search.height + gap);
          expect((await page.locator("header").boundingBox()).height).toBe(initialHeight + toolbar.height - 38 - (stacked ? 12 : 0));
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          if (width === 320) await page.screenshot({ path: testInfo.outputPath(`header-${font}-320.png`) });
        }
        expect(canvas.writes).toEqual([]);
      });
    }

    test("keyboard order follows the utility row, search, Filters and attention tabs", async ({ page, canvas }) => {
      canvas.rows.splice(1);
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(1);
      await focusToolbarWithKeyboard(page, "#open-inbox");
      for (const selector of ["#force-refresh", "#shortcuts-toggle", "#settings-toggle", "#search", "#filters-toggle", "#attention-all"]) {
        await page.keyboard.press("Tab");
        await expect(page.locator(selector)).toBeFocused();
      }
      expect(canvas.writes).toEqual([]);
    });
  });
}

test.describe("development footer", () => {
  const branch = `feature/<footer>&${"long-branch-name-".repeat(20)}`;
  test.use({ development: { version: CURRENT_VERSION, branch } });

  test("shows the version and literal branch without overflowing a narrow panel", async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(canvas.url);
    const label = page.locator("footer #development-build");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(`dev (v${CURRENT_VERSION}) ${branch}`);
    await expect(label.locator("*")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole("button", { name: "Force refresh", exact: true }).click();
    await expect(label).toHaveText(`dev (v${CURRENT_VERSION}) ${branch}`);
    expect(canvas.writes).toEqual([]);
  });
});

test.describe("startup recovery", () => {
  test.use({ assetFailure: true, desktopEnabled: true });

  test("opens an accessible recovery page and loads the inbox automatically on the same URL", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.getByRole("status")).toContainText("Retrying in the background");
    expect(canvas.requests).toEqual([]);
    expect(canvas.writes).toEqual([]);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    canvas.recoverAssets();
    await expect(page.locator(".row")).toHaveCount(50, { timeout: 10_000 });
    await expect(page).toHaveURL(canvas.url);
    await expect(page.getByRole("searchbox", { name: searchName })).toBeEnabled();
    expect(canvas.writes).toEqual([]);
  });
});

test("real assets load under CSP, render titles as text, and support search and pagination", async ({ page, canvas }) => {
  const response = await page.goto(canvas.url);
  expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(page.locator(".metadata").getByText("Unread", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)> Needle widget 1" })).toBeVisible();
  await expect(page.locator(".row img")).toHaveCount(0);
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  await expect(page.locator(".row")).toHaveCount(3);
  await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Load more (up to 50)", exact: true })).toBeHidden();
  await page.getByRole("searchbox", { name: searchName }).fill("");
  await expect(page.locator(".row")).toHaveCount(53);
  expect(canvas.writes).toEqual([]);
});

test("clearing search leaves the selected attention tab unchanged", async ({ page, canvas }) => {
  await canvas.preferences.update({ hideEmptyTabs: false });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  const requests = canvas.requests.length;
  const search = page.getByRole("searchbox");
  for (const [label, count] of [["Review Requested", 50], ["Assigned", 0]]) {
    const tab = page.getByRole("tab", { name: `${label} (${count})`, exact: true });
    await tab.click();
    await search.fill("No matching notification");
    await expect(page.locator(".row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
    await search.fill("");
    await expect(search).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".row")).toHaveCount(count);
  }
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  expect(canvas.requests.length).toBe(requests);
  expect(canvas.writes).toEqual([]);
});

test("issue and PR numbers render in metadata and search selects the notification thread, not its issue number", async ({ page, canvas }) => {
  canvas.rows.splice(3);
  canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/7";
  canvas.rows[1].subject.type = "PullRequest";
  canvas.rows[1].subject.url = "https://api.github.com/repos/example/widgets/pulls/8";
  await page.goto(canvas.url);
  await expect(page.getByRole("link", { name: "<img src=x onerror=alert(1)> Needle widget 1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needle widget 2" })).toHaveAttribute("href", "https://github.com/example/widgets/pull/8");
  await expect(page.locator(".metadata").getByText("Issue #7", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata").getByText("Pull Request #8", { exact: true })).toBeVisible();
  await expect(page.locator(".metadata").getByText("Issue", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Needle tool" })).toBeVisible();
  await expect(page.locator(".row img")).toHaveCount(0);
  await page.getByRole("searchbox", { name: searchName }).fill("#7");
  await expect(page.locator(".row")).toHaveCount(1);
  await page.getByRole("button", { name: "Mark as read: #7 <img src=x onerror=alert(1)> Needle widget 1", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(".mark-read")).toBeDisabled();
  expect(canvas.writes).toEqual(["1"]);
});

test("attention tabs combine with search and constrain repository reads to matching loaded reasons", async ({ page, canvas }) => {
  await canvas.preferences.update({ hideEmptyTabs: false });
  for (const row of canvas.rows) row.reason = "subscribed";
  canvas.rows[0].reason = "review_requested";
  canvas.rows[2].reason = "review_requested";
  canvas.rows[3].reason = "review_requested";
  canvas.rows[3].subject.title = "Needle review widget";
  canvas.rows[50].reason = "review_requested";
  await page.goto(canvas.url);
  await expect(page.getByRole("tab", { name: "All (50)", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("searchbox").fill("Needle");
  await page.getByRole("tab", { name: /^Review Requested \(\d+\)$/ }).click();
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator("#count")).toHaveText("50 loaded \u00b7 50 unread \u00b7 3 matching");
  await expect(page.getByRole("tab", { name: "All (50)", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Review Requested (3)", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Mark 2 as read in example/widgets; 2 shown, loaded notifications", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator(".row.unread")).toHaveCount(1);
  expect(canvas.writes.toSorted()).toEqual(["1", "4"]);
  expect(canvas.rows.find(row => row.id === "2").unread).toBe(true);
  expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
  await expect(page.getByRole("tab", { name: "Review Requested (3)", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Assigned \(\d+\)$/ }).click();
  await expect(page.locator("#empty-title")).toHaveText("No matches in loaded notifications");
  await expect(page.locator("#count")).toHaveText("50 loaded \u00b7 48 unread \u00b7 0 matching");
  await expect(page.getByRole("tab", { name: "All (50)", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Review Requested (3)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Force refresh", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Assigned \(\d+\)$/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox")).toHaveValue("Needle");
  await page.getByRole("tab", { name: /^Review Requested \(\d+\)$/ }).click();
  await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.getByRole("tab", { name: "Review Requested (4)", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "All (53)", exact: true })).toBeVisible();
});

test("attention tabs are keyboard accessible and fit narrow light and dark panels", async ({ page, canvas }, testInfo) => {
  canvas.rows.splice(7);
  ["review_requested", "mention", "team_mention", "assign", "author", "comment", "subscribed"]
    .forEach((reason, index) => { canvas.rows[index].reason = reason; });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(canvas.url);
  const tabs = page.getByRole("tablist", { name: "Attention filters" });
  await expect(tabs.getByRole("tab")).toHaveText(["All (7)", "Mine (0+)", "Assigned (1)", "Participating (6)", "Mentioned (1)", "Team Mentioned (1)", "Review Requested (1)"]);
  await page.getByRole("tab", { name: /^All \(\d+\)$/ }).focus();
  await page.keyboard.press("ArrowLeft");
  const reviews = page.getByRole("tab", { name: /^Review Requested \(\d+\)$/ });
  await expect(reviews).toBeFocused();
  await expect(reviews).toBeInViewport({ ratio: 1 });
  await expect(reviews).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Review Requested (1)", exact: true })).toBeVisible();
  await expect(page.locator(".row")).toHaveCount(1);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const mentioned = page.getByRole("tab", { name: /^Mentioned \(\d+\)$/ });
  await expect(mentioned).toBeFocused();
  await expect(mentioned).toBeInViewport({ ratio: 1 });
  await expect(mentioned).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".row")).toHaveCount(1);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`attention-${colorScheme}.png`) });
  }
  await page.keyboard.press("End");
  await expect(reviews).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^All \(\d+\)$/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Scroll attention tabs right", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Collapse all", exact: true })).toBeFocused();
  expect(canvas.writes).toEqual([]);
});

test("overflow arrows scroll without filtering and stay accessible at both ends", async ({ page, canvas }, testInfo) => {
  await canvas.preferences.update({ hideEmptyTabs: false });
  canvas.rows.splice(2);
  await page.setViewportSize({ width: 320, height: 800 });
  const filters = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/filters") filters.push(request);
  });
  await page.goto(canvas.url);
  const previous = page.getByRole("button", { name: "Scroll attention tabs left", exact: true });
  const next = page.getByRole("button", { name: "Scroll attention tabs right", exact: true });
  const strip = page.getByRole("tablist", { name: "Attention filters" });
  const all = page.getByRole("tab", { name: "All (2)", exact: true });
  await expect(previous).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(strip).toHaveCSS("scrollbar-width", "none");
  expect(await strip.evaluate(node => getComputedStyle(node, "::-webkit-scrollbar").display)).toBe("none");
  await expect(page.locator(".row")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("overflow-start.png") });
  await next.focus();
  await next.press("Enter");
  await expect.poll(() => strip.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  await expect(next).toBeFocused();
  await expect(previous).toBeEnabled();
  for (let index = 0; index < 6 && await next.isEnabled(); index++) await next.press("Enter");
  await expect(next).toBeDisabled();
  await expect(next).toBeFocused();
  await expect(next).toHaveCSS("opacity", "1");
  await expect(page.getByRole("tab", { name: /^Review Requested \(\d+\)$/ })).toBeInViewport({ ratio: 1 });
  const end = await strip.evaluate(node => node.scrollLeft);
  await next.press("Enter");
  expect(await strip.evaluate(node => node.scrollLeft)).toBe(end);
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".row")).toHaveCount(2);
  expect(filters).toEqual([]);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("overflow-end.png") });
  await previous.focus();
  for (let index = 0; index < 6 && await previous.isEnabled(); index++) await previous.press("Space");
  await expect(previous).toBeDisabled();
  await expect(previous).toBeFocused();
  await expect(all).toBeInViewport({ ratio: 1 });
  await strip.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await page.setViewportSize({ width: 960, height: 800 });
  await expect(previous).toBeHidden();
  await expect(next).toBeHidden();
  await expect(all).toBeFocused();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(next).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(canvas.writes).toEqual([]);
});

test("search preserves total tab counts and overflow controls without resizing", async ({ page, canvas }) => {
  await canvas.preferences.update({ hideEmptyTabs: false });
  await page.goto(canvas.url);
  const strip = page.getByRole("tablist", { name: "Attention filters" });
  const next = page.getByRole("button", { name: "Scroll attention tabs right", exact: true });
  await expect(page.getByRole("tab", { name: "All (50)", exact: true })).toBeVisible();
  await expect(next).toBeHidden();
  const width = await strip.evaluate(node => {
    const style = getComputedStyle(node);
    const main = getComputedStyle(document.querySelector("main"));
    return Math.ceil([...node.children].reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0) +
      parseFloat(style.gap) * (node.children.length - 1) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
      parseFloat(main.paddingLeft) + parseFloat(main.paddingRight) - 4);
  });
  await page.setViewportSize({ width, height: 800 });
  await expect(next).toBeVisible();
  const counts = await strip.getByRole("tab").allTextContents();
  for (const [query, matching] of [["Needle", 3], ["No matching notification", 0], ["", 50]]) {
    await page.getByRole("searchbox").fill(query);
    await expect(page.locator("#count")).toHaveText(query ? `50 loaded \u00b7 50 unread \u00b7 ${matching} matching` : "50 loaded \u00b7 50 unread");
    await expect(strip.getByRole("tab")).toHaveText(counts);
    await expect(page.locator(".row")).toHaveCount(matching);
    await expect(next).toBeVisible();
  }
  expect(canvas.writes).toEqual([]);
});

test("keyboard reads mark exactly one notification and focus its retained Done action", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  const button = page.getByRole("button", { name: "Mark as read: Needle widget 2", exact: true });
  await button.focus();
  await button.press("Enter");
  await expect(page.locator(".row")).toHaveCount(50);
  await expect(button).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark as done: Needle widget 2", exact: true })).toBeFocused();
  expect(canvas.writes).toEqual(["2"]);
});

for (const width of [320, 480, 960]) {
  test(`row icons are compact, visible and have unclipped accessible tooltips at ${width}px`, async ({ page, canvas }, testInfo) => {
    canvas.rows.splice(3);
    canvas.rows[0].subject.title = "Add notification filters";
    canvas.rows[1].subject.title = "Update installation guidance";
    canvas.rows[2].subject.title = "Review release checklist";
    await page.setViewportSize({ width, height: 900 });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(3);
    const read = page.locator('[data-focus-key="read:1"]');
    const done = page.locator('[data-focus-key="done:1"]');
    const readBounds = await read.boundingBox();
    const doneBounds = await done.boundingBox();
    expect(readBounds.width).toBe(32);
    expect(readBounds.height).toBe(32);
    expect(doneBounds.y).toBe(readBounds.y);
    expect(doneBounds.x - readBounds.x - readBounds.width).toBe(4);
    const toolbar = page.locator("#force-refresh");
    for (const property of ["border-top-width", "border-top-color", "border-radius", "color"]) {
      const expected = await toolbar.evaluate((node, property) => getComputedStyle(node).getPropertyValue(property), property);
      await expect(read).toHaveCSS(property, expected);
      await expect(done).toHaveCSS(property, expected);
    }
    await expect(read).toHaveCSS("border-top-width", "1px");
    await expect(read).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(done).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".row > time")).toHaveCount(0);
    await expect(page.locator(".row .metadata time")).toHaveCount(3);
    await expect(page.locator(".metadata").getByText("Unread", { exact: true })).toHaveCount(0);
    for (const separator of await page.locator(".metadata-separator").all()) {
      await expect(separator).toHaveText("\u00b7");
      await expect(separator).toHaveAttribute("aria-hidden", "true");
    }
    for (const metadata of await page.locator(".metadata").all()) {
      await expect(metadata.locator(".metadata-item:visible")).toHaveCount(3);
      await expect(metadata.locator(".metadata-separator:visible")).toHaveCount(2);
      await expect(metadata).not.toContainText(/Open (?:GitHub|repository)/);
      const fields = await metadata.evaluate(node => [...node.querySelectorAll(".metadata-item:not([hidden])")].map(part => {
        const rect = [...part.children].find(child => !child.classList.contains("metadata-separator")).getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      }));
      for (let index = 1; index < fields.length; index++) {
        if (fields[index].y > fields[index - 1].y + 1) expect(fields[index].x).toBeCloseTo(fields[0].x);
      }
    }
    await expect(page.locator(".row .metadata time").first()).toHaveAttribute("datetime", canvas.rows[0].updated_at);
    await expect(read.locator("svg")).toBeVisible();
    await expect(done.locator("svg")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`row-icons-${width}.png`), fullPage: true });

    for (const id of ["3", "2"]) {
      for (const action of ["read", "done"]) {
        const button = page.locator(`[data-focus-key="${action}:${id}"]`);
        const tooltip = page.locator(`#row-${action}-${id}-tooltip`);
        await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
        await page.getByRole("searchbox").focus();
        await expect(tooltip).toBeHidden();
        await expect(button).not.toHaveAttribute("title");
        await expect(button).toHaveText("");
        await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
        await button.hover();
        expect(await tooltip.isVisible()).toBe(true);
        await expect(tooltip).toHaveText(`Mark as ${action}`);
        await expect(button).toHaveAccessibleDescription(`Mark as ${action}`);
        const bounds = await tooltip.boundingBox();
        const card = await button.evaluate(node => {
          const rect = node.closest(".repo-group").getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right };
        });
        expect(bounds.x).toBeGreaterThanOrEqual(card.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(card.right);
        expect(bounds.y).toBeGreaterThanOrEqual(card.y);
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="tooltip"]')?.id,
          { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })).toBe(await tooltip.getAttribute("id"));
        await tooltip.hover();
        await expect(tooltip).toBeVisible();
        await button.focus();
        await button.press("Escape");
        await expect(tooltip).toBeHidden();
        await expect(button).toBeFocused();
        await page.getByRole("searchbox").focus();
        await button.focus();
        expect(await tooltip.isVisible()).toBe(true);
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await expect(tooltip).toBeHidden();
      }
    }
    expect(canvas.writes).toEqual([]);
  });
}

test("repository group controls remain usable for a single matching notification", async ({ page, canvas }) => {
  canvas.rows.splice(2);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(canvas.url);
  await expect(page.locator(".repo-count")).toHaveText("2 loaded \u00b7 2 unread");
  await expect(page.locator(".repo-read")).toHaveCount(1);
  await page.getByRole("searchbox").fill("Needle widget 2");
  await expect(page.locator(".repo-count")).toHaveText("1 loaded \u00b7 1 unread");
  await expect(page.locator(".repo-read")).toHaveAccessibleDescription("Mark 1 as read");
  await expect(page.locator(".repo-done")).toBeVisible();
  await expect(page.locator('[data-focus-key="read:2"]')).toBeVisible();
  await expect(page.locator('[data-focus-key="done:2"]')).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await expect(page.locator(".repo-read")).toHaveCount(1);
  await page.locator('[data-focus-key="read:1"]').click();
  await expect(page.locator(".repo-count")).toHaveText("2 loaded \u00b7 1 unread");
  await expect(page.locator(".repo-read")).toHaveAccessibleDescription("Mark 1 as read");
  await expect(page.locator('[data-focus-key="read:2"]')).toBeVisible();
  await expect(page.locator('[data-focus-key="done:2"]')).toBeVisible();
  await page.getByRole("button", { name: "Mark 2 as done in example/widgets; 2 shown, loaded notifications", exact: true }).click();
  await expect(page.locator(".row")).toHaveCount(0);
  await expect(page.locator(".repo-actions")).toHaveCount(0);
  expect(canvas.writes[0]).toBe("1");
  expect(canvas.writes.slice(1).toSorted()).toEqual(["1", "2"]);
  expect(canvas.doneWrites.toSorted()).toEqual(["1", "2"]);
});

for (const groupBy of ["repo", "date", "none"]) {
  test(`Tab navigation reaches separate read and Done actions in ${groupBy} view`, async ({ page, canvas }) => {
    canvas.rows.splice(2);
    await canvas.preferences.update({ groupBy });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(2);
    expect(canvas.writes).toEqual([]);
    const title = page.locator(".row-link").first();
    await title.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-focus-key="read:1"]')).toBeFocused();
    await page.keyboard.press("Tab");
    const done = page.locator('[data-focus-key="done:1"]');
    await expect(done).toBeFocused();
    await expect(done).toHaveAccessibleName("Mark as done: <img src=x onerror=alert(1)> Needle widget 1");
    await done.press("Enter");
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator('[data-focus-key="done:2"]')).toBeFocused();
    expect(canvas.writes).toEqual(["1"]);
    expect(canvas.doneWrites).toEqual(["1"]);
    await page.reload();
    await expect(page.locator(".row")).toHaveCount(1);
    await expect(page.locator('[data-focus-key="done:1"]')).toHaveCount(0);
    expect(canvas.writes).toEqual(["1"]);
  });
}

for (const groupBy of ["repo", "date"]) {
  for (const action of ["read", "done"]) {
    test(`keyboard ${action} actions retain focus beside a collapsed ${groupBy} group`, async ({ page, canvas }) => {
      canvas.rows.splice(2);
      canvas.rows[0].repository.full_name = "example/alpha";
      canvas.rows[0].updated_at = "2026-01-11T12:00:00Z";
      canvas.rows[1].repository.full_name = "example/zulu";
      await canvas.preferences.update({ groupBy });
      await page.goto(canvas.url);
      await page.locator(".repo-toggle").nth(1).click();
      const button = page.locator(`[data-focus-key="${action}:1"]`);
      await button.focus();
      await button.press("Enter");
      await expect(page.locator(".row")).toHaveCount(action === "read" ? 2 : 1);
      if (action === "read") await expect(page.locator('[data-focus-key="done:1"]')).toBeFocused();
      else await expect(page.getByRole("searchbox", { name: searchName })).toBeFocused();
      await expect(page.locator(".repo-toggle").last()).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".row").last()).toBeHidden();
      expect(canvas.writes).toEqual(["1"]);
      expect(canvas.doneWrites).toEqual(action === "done" ? ["1"] : []);
    });
  }
}

test("repository actions affect only shown loaded matches, not another repository or unloaded rows", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  const group = page.getByRole("button", { name: "Mark 2 as read in example/widgets; 2 shown, loaded notifications", exact: true });
  await expect(group).toBeVisible();
  await group.click();
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator(".row.unread")).toHaveCount(1);
  await expect(page.locator("#batch-progress")).toBeHidden();
  expect(canvas.writes.toSorted()).toEqual(["1", "2"]);
  expect(canvas.rows.find(row => row.id === "3").unread).toBe(true);
  expect(canvas.rows.find(row => row.id === "51").unread).toBe(true);
  await expect(page.getByRole("searchbox", { name: searchName })).toBeEnabled();
});

test("refresh preserves keyboard focus and collapsed repository state", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  const disclosure = page.locator('[data-focus-key="repo:example/widgets"]');
  await expect(disclosure).toHaveAccessibleName(/example\/widgets 49 loaded \u00b7 49 unread/);
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  await refresh.focus();
  const requestCount = canvas.requests.length;
  canvas.rows[0].subject.title = "Changed during refresh";
  await refresh.press("Enter");
  await expect.poll(() => canvas.requests.length).toBeGreaterThan(requestCount);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(refresh).toBeFocused();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.press("Enter");
  await expect(page.getByRole("link", { name: "Changed during refresh" })).toBeVisible();
});

test("the toolbar refresh icon shows the current update age on hover and keyboard focus", async ({ page, canvas }, testInfo) => {
  canvas.rows.splice(1);
  await page.setViewportSize({ width: 320, height: 800 });
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  const tooltip = page.locator("#refresh-tooltip");
  const tooltipText = page.locator("#refresh-tooltip-text");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".toolbar > #refresh-control + #shortcuts-control + #settings")).toHaveCount(1);
  await expect(refresh).not.toHaveAttribute("title");
  await expect(tooltip).toBeHidden();
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh).toHaveText("");
  await expect(page.locator("#updated, footer button")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  canvas.advance(23_000);
  await page.clock.setFixedTime(new Date(initial.lastFetchedAt + 23_000));
  await refresh.hover();
  expect(await tooltip.isVisible()).toBe(true);
  await expect(tooltip).toHaveText("Last updated 23 seconds ago");
  await expect(tooltipText).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
  const bounds = await tooltip.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("refresh-tooltip-light.png") });
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(tooltipText).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("refresh-tooltip-dark.png") });
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  canvas.advance(1000);
  await page.clock.setFixedTime(new Date(initial.lastFetchedAt + 24_000));
  await refresh.focus();
  expect(await tooltip.isVisible()).toBe(true);
  await expect(tooltip).toHaveText("Last updated 24 seconds ago");
  await expect(refresh).toHaveAccessibleDescription("Last updated 24 seconds ago");
  await refresh.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(refresh).toBeFocused();
  await page.getByRole("searchbox").focus();
  await refresh.focus();
  expect(await tooltip.isVisible()).toBe(true);
  const requestCount = canvas.requests.length;
  canvas.rows[0].subject.title = "Updated from the toolbar";
  await refresh.press("Enter");
  await expect(page.getByRole("link", { name: "Updated from the toolbar" })).toBeVisible();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(tooltip).toHaveText("Last updated 0 seconds ago");
  await expect(refresh).toBeFocused();
  await expect(refresh.locator("svg")).toHaveCount(1);
  expect(canvas.requests.length).toBe(requestCount + 1);
  expect(canvas.writes).toEqual([]);
});

test("the refresh icon exposes pending state, preserves queued clicks, and respects reduced motion", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  const refresh = page.getByRole("button", { name: "Force refresh", exact: true });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const before = canvas.requests.length;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  canvas.setRequestHook(args => args.at(-1).startsWith("/notifications") ? held : undefined);
  try {
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#refresh-tooltip-text")).toHaveText(/^Refreshing\. Last updated /);
    await expect(refresh).toBeEnabled();
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "refresh-spin");
    const rotation = await refresh.locator("svg").evaluate(node => {
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration / 4;
      const transform = new DOMMatrix(getComputedStyle(node).transform);
      animation.play();
      return Math.atan2(transform.b, transform.a) * 180 / Math.PI;
    });
    expect(rotation, "The sync arrows rotate counterclockwise").toBeCloseTo(-90, 1);
    await refresh.click();
    await expect(page.locator("#refresh-tooltip-text")).toHaveText(/^Refresh queued\. Last updated /);
    canvas.setRequestHook(undefined);
    release();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh.locator("svg")).toHaveCount(1);
    expect(canvas.requests.length).toBe(before + 2);
    expect(canvas.writes).toEqual([]);
  } finally {
    release();
  }
});

test("all toolbar icons use matching instant tooltips with keyboard and Escape support", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  const heading = page.getByRole("heading", { name: "GitHub Notifications", exact: true });
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", dark ? "dark" : "light");
    for (const [id, tooltipId, label] of [
      ["open-inbox", "inbox-tooltip", "Open GitHub inbox"],
      ["force-refresh", "refresh-tooltip", null],
      ["shortcuts-toggle", "shortcuts-tooltip", "Keyboard shortcuts (?)"],
      ["settings-toggle", "settings-tooltip", "Settings"],
    ]) {
      const control = page.locator(`#${id}`);
      const tooltip = page.locator(`#${tooltipId}`);
      await expect(control).not.toHaveAttribute("title");
      await heading.hover();
      await page.getByRole("searchbox").focus();
      await expect(tooltip).toBeHidden();
      await control.hover();
      expect(await tooltip.isVisible()).toBe(true);
      if (label) await expect(tooltip).toHaveText(label);
      await expect(control).toHaveAccessibleDescription(await tooltip.textContent());
      const text = tooltip.locator(".tooltip-content");
      await expect(text).toHaveCSS("background-color", await page.locator("body").evaluate(node => getComputedStyle(node).backgroundColor));
      await expect(text).toHaveCSS("font-weight", "400");
      const bounds = await tooltip.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
      await heading.hover();
      await control.focus();
      expect(await tooltip.isVisible()).toBe(true);
      await control.press("Escape");
      await expect(tooltip).toBeHidden();
      await expect(control).toBeFocused();
    }
  }
  const settings = page.locator("#settings-toggle");
  await settings.press("Enter");
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#settings-tooltip")).toBeHidden();
  await page.getByRole("combobox", { name: "Theme", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(settings).toBeFocused();
  await expect(page.locator("#settings-tooltip")).toBeHidden();
  expect(canvas.writes).toEqual([]);
});

test("opening and closing Settings dismisses its tooltip until a fresh hover or focus", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  const settings = page.locator("#settings-toggle");
  const tooltip = page.locator("#settings-tooltip");
  const panel = page.locator("#settings-panel");
  for (const trigger of ["pointer", "Enter", "Space"]) {
    await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
    await page.getByRole("searchbox").focus();
    if (trigger === "pointer") await settings.hover();
    else await focusToolbarWithKeyboard(page, "#settings-toggle");
    await expect(tooltip).toBeVisible();
    if (trigger === "pointer") await settings.click();
    else await settings.press(trigger);
    await expect(panel).toBeVisible();
    await expect(tooltip).toBeHidden();
    await settings.hover();
    await settings.focus();
    await expect(tooltip).toBeHidden();
    if (trigger === "pointer") await settings.click();
    else await settings.press(trigger);
    await expect(panel).toBeHidden();
    await expect(settings).toHaveAttribute("aria-expanded", "false");
    await expect(tooltip).toBeHidden();
    await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
    await expect(tooltip).toBeHidden();
    if (trigger === "pointer") await settings.hover();
    else {
      await focusToolbarWithKeyboard(page, "#settings-toggle");
    }
    await expect(tooltip).toBeVisible();
  }
  expect(canvas.writes).toEqual([]);
});

test("activating Open inbox and losing canvas focus dismiss tooltips despite retained element focus", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  const inbox = page.getByRole("link", { name: "Open GitHub inbox", exact: true });
  const inboxTooltip = page.locator("#inbox-tooltip");
  await page.evaluate(() => {
    // Exercise activation without navigating the test browser to the real GitHub inbox.
    document.getElementById("open-inbox").addEventListener("click", event => event.preventDefault());
  });
  for (const trigger of ["pointer", "keyboard"]) {
    await page.getByRole("heading", { name: "GitHub Notifications", exact: true }).hover();
    await page.getByRole("searchbox").focus();
    if (trigger === "pointer") await inbox.hover();
    else await focusToolbarWithKeyboard(page, "#open-inbox");
    await expect(inboxTooltip).toBeVisible();
    if (trigger === "pointer") await inbox.click();
    else await inbox.press("Enter");
    await expect(inboxTooltip).toBeHidden();
    if (trigger === "keyboard") await expect(inbox).toBeFocused();
    await expect(inbox).toHaveAttribute("href", "https://github.com/notifications");
    await expect(inbox).toHaveAttribute("target", "_blank");
  }
  for (const [control, tooltip] of [
    ["#open-inbox", "#inbox-tooltip"],
    ["#force-refresh", "#refresh-tooltip"],
    ["#settings-toggle", "#settings-tooltip"],
  ]) {
    await focusToolbarWithKeyboard(page, control);
    await expect(page.locator(tooltip)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.locator(tooltip)).toBeHidden();
    await expect(page.locator(control)).toBeFocused();
  }
  expect(canvas.writes).toEqual([]);
});

test("a stationary tooltip updates at 15-second ticks without fetching notifications", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  const tooltip = page.locator("#refresh-tooltip-text");
  await page.getByRole("button", { name: "Force refresh", exact: true }).hover();
  await expect(tooltip).toHaveText("Last updated 0 seconds ago");
  for (let tick = 0; tick < 3; tick++) {
    const previous = await tooltip.textContent();
    await page.clock.runFor(14_999);
    await expect(tooltip).toHaveText(previous);
    await page.clock.runFor(1);
    const age = await page.evaluate(fetchedAt => Math.floor(Math.max(0, Date.now() - fetchedAt) / 1000), initial.lastFetchedAt);
    await expect(tooltip).toHaveText(`Last updated ${age} seconds ago`);
    expect(canvas.requests.filter(path => path.startsWith("/notifications")).length).toBe(1);
  }
  expect(canvas.writes).toEqual([]);
});

test("foreground checks use a 60-second interval, pause while hidden, and refresh immediately on return", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.addInitScript(() => {
    const NativeIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeIntersectionObserver {
      constructor(callback, options) {
        super((entries, observer) => {
          callback(entries, observer);
          const entry = entries.find(entry => entry.target === document.documentElement);
          if (entry) window.canvasIntersecting = entry.isIntersecting;
        }, options);
      }
    };
  });
  const localRequests = [];
  const pending = new Set();
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (["/api/state", "/api/refresh"].includes(path)) {
      localRequests.push(path);
      pending.add(request);
    }
  });
  for (const event of ["requestfinished", "requestfailed"]) page.on(event, request => pending.delete(request));
  await page.clock.install();
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  const selected = page.waitForResponse(async response => response.url().endsWith("/api/state") &&
    (await response.json()).subjectSelectionVersion > 0);
  await page.goto(canvas.url);
  const initial = await (await initialResponse).json();
  await selected;
  await expect(page.locator(".row")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.canvasIntersecting)).toBe(true);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await expect.poll(() => pending.size).toBe(0);
  expect(initial.nextRefreshAt - initial.lastFetchedAt).toBe(60_000);
  await expect(page.locator("#refresh-tooltip-text")).toHaveText(/Last updated \d+ seconds? ago/);
  const notificationRequests = () => canvas.requests.filter(path => path.startsWith("/notifications")).length;
  expect(notificationRequests()).toBe(1);

  const beforeHiding = localRequests.length;
  await page.evaluate(() => { document.documentElement.style.display = "none"; });
  await expect(page.locator("html")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.canvasIntersecting)).toBe(false);
  await expect.poll(() => pending.size).toBe(0);
  canvas.advance(61_000);
  await page.clock.runFor(61_000);
  await expect.poll(() => pending.size).toBe(0);
  expect(localRequests).toHaveLength(beforeHiding);
  expect(notificationRequests()).toBe(1);

  canvas.rows[0].subject.title = "Updated when visible again";
  const resumedRequest = page.waitForRequest(request => request.url().endsWith("/api/refresh"));
  const resumedResponse = page.waitForResponse(response => response.url().endsWith("/api/refresh"));
  await page.evaluate(() => { document.documentElement.style.display = ""; });
  await expect.poll(() => page.evaluate(() => window.canvasIntersecting)).toBe(true);
  expect((await resumedRequest).postDataJSON()).toEqual({ force: true });
  const resumed = await (await resumedResponse).json();
  await expect(page.getByRole("link", { name: "Updated when visible again" })).toBeVisible();
  await expect.poll(() => pending.size).toBe(0);
  expect(resumed.nextRefreshAt - resumed.lastFetchedAt).toBe(60_000);
  expect(notificationRequests()).toBe(2);

  canvas.rows[0].subject.title = "Updated on the next foreground check";
  await page.clock.setSystemTime(new Date(resumed.lastFetchedAt));
  canvas.advance(59_000);
  await page.clock.runFor(59_999);
  await expect.poll(() => pending.size).toBe(0);
  expect(notificationRequests()).toBe(2);
  canvas.advance(2000);
  await page.clock.runFor(5001);
  await expect(page.getByRole("link", { name: "Updated on the next foreground check" })).toBeVisible();
  expect(notificationRequests()).toBe(3);
  expect(canvas.writes).toEqual([]);
});

test.describe("synchronized desktop alerts", () => {
  test.use({ desktopEnabled: true });

  test("foreground polling updates the inbox and alerts together, then hidden alerts retain the background cadence", async ({ page, canvas }) => {
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(50);
    await canvas.desktop.sync();
    expect(canvas.deliveries).toEqual([]);
    const notificationRequests = () => canvas.requests.filter(path => path.startsWith("/notifications")).length;
    const unreadPages = () => canvas.requests.filter(path => path.startsWith("/notifications") && path.includes("all=false"))
      .map(path => Number(new URL(path, "https://api.github.com").searchParams.get("page")));
    expect(notificationRequests()).toBe(3);
    expect(unreadPages()).toEqual([1, 2]);

    const time = canvas.advance(61_000);
    canvas.rows[0].updated_at = new Date(time).toISOString();
    canvas.rows[0].subject.title = "Synchronized foreground notification";
    await page.clock.setFixedTime(new Date(time));
    await expect(page.getByRole("link", { name: "Synchronized foreground notification" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => canvas.deliveries.map(alert => alert.body)).toEqual(["Synchronized foreground notification"]);
    expect(notificationRequests()).toBe(6);
    expect(unreadPages()).toEqual([1, 2, 1, 2]);

    await page.evaluate(() => { document.documentElement.style.display = "none"; });
    await expect(page.locator("html")).toBeHidden();
    canvas.rows.at(-1).updated_at = new Date(canvas.advance(30_000)).toISOString();
    canvas.rows.at(-1).subject.title = "Background notification";
    await canvas.desktop.check();
    expect(canvas.deliveries).toHaveLength(1);
    expect(notificationRequests()).toBe(6);
    canvas.advance(31_000);
    await canvas.desktop.check();
    expect(canvas.deliveries.map(alert => alert.body)).toEqual([
      "Synchronized foreground notification", "Background notification",
    ]);
    expect(notificationRequests()).toBe(8);
    expect(unreadPages()).toEqual([1, 2, 1, 2, 1, 2]);
    expect(canvas.writes).toEqual([]);
  });
});

test("Settings supports keyboard dismissal and persists theme and auto-open across reloads", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  const settings = page.getByLabel("Settings", { exact: true });
  await settings.focus();
  await openSettings(page, () => settings.press("Enter"));
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  await expect(theme).toBeEnabled();
  await expect(theme.locator("option")).toHaveText(["Match Copilot", "Dark", "Light"]);
  await expect(theme).toHaveValue("system");
  await theme.focus();
  await theme.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await expect(theme).toBeFocused();
  const autoOpen = page.getByRole("switch", { name: "Auto-open", exact: true });
  await autoOpen.click();
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).not.toHaveAttribute("open", "");
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  await settings.click();
  await expect(theme).toHaveValue("dark");
  await expect(autoOpen).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Desktop notifications", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("combobox", { name: "Sound", exact: true })).toBeHidden();
  await expect(page.locator("#desktop-sound")).toHaveValue("default");
  expect(await canvas.preferences.read()).toEqual({
    revision: expect.any(Number), updatedAt: expect.any(String),
    matchGitHubInbox: true, autoOpen: true, darkMode: true, desktopNotifications: false, terminalNotifierHintDismissed: false, desktopSound: "default", groupBy: "repo", copilotIntegration: true, confirmCopilotActions: true, hideEmptyTabs: true, keyboardShortcuts: true,
  });
  await theme.selectOption("system");
  await expect.poll(async () => (await canvas.preferences.read()).darkMode).toBeNull();
  await page.reload();
  await settings.click();
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
  expect(canvas.deliveries).toEqual([]);
});

test("All notifications stays globally newest first through pagination, search and reload", async ({ page, canvas }) => {
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(50);
  await page.getByLabel("Settings", { exact: true }).click();
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  await expect(grouping).toHaveValue("repo");
  await grouping.selectOption("none");
  await expect(page.locator(".repo-group")).toHaveCount(1);
  await expect(page.locator(".repo-name")).toHaveText("All notifications");
  await expect(page.locator(".repo-count")).toHaveText("50 loaded \u00b7 50 unread");
  await expect(page.locator("#collapse")).toBeVisible();
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.slice(0, 50).map(row => row.subject.title));
  await expect(page.locator(".row .repository").nth(2)).toHaveText("example/tools");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Load more (up to 50)", exact: true }).click();
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.map(row => row.subject.title));
  await expect(page.locator(".repo-count")).toHaveText("53 loaded \u00b7 53 unread");
  await page.getByRole("searchbox", { name: searchName }).fill("Needle");
  await expect(page.locator(".row .title")).toHaveText(canvas.rows.filter(row => row.subject.title.includes("Needle")).map(row => row.subject.title));
  await page.reload();
  await page.getByLabel("Settings", { exact: true }).click();
  await expect(grouping).toHaveValue("none");
  await expect(page.locator(".repo-group")).toHaveCount(1);
  await expect(page.locator(".repo-name")).toHaveText("All notifications");
  expect(canvas.writes).toEqual([]);
});

test("date groups span repositories and keep API row order and action focus", async ({ page, canvas }) => {
  canvas.rows.splice(4);
  canvas.rows[0].updated_at = "2026-01-09T23:59:00Z";
  canvas.rows[1].updated_at = "2026-01-10T00:01:00Z";
  canvas.rows[2].updated_at = "2026-01-10T00:02:00Z";
  canvas.rows[3].updated_at = "2026-01-09T00:00:00Z";
  await page.goto(canvas.url);
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("combobox", { name: "Group By", exact: true }).selectOption("date");
  await expect(page.locator(".repo-name")).toHaveText(["January 10, 2026", "January 9, 2026"]);
  await expect(page.locator(".row .title")).toHaveText([1, 2, 0, 3].map(index => canvas.rows[index].subject.title));
  await expect(page.locator('.repo-group [data-batch-scope="date"].repo-read')).toHaveCount(2);
  await expect(page.locator('[data-batch-scope="shown"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  const read = page.getByRole("button", { name: "Mark as read: Needle tool", exact: true });
  await read.focus();
  await read.press("Enter");
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Mark as done: Needle tool", exact: true })).toBeFocused();
  expect(canvas.writes).toEqual(["3"]);
  const collapse = page.getByRole("button", { name: "Collapse all", exact: true });
  await collapse.click();
  await expect(page.locator(".row:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.locator(".row:visible")).toHaveCount(4);
});

for (const width of [320, 480, 960]) {
  for (const theme of ["light", "dark"]) {
    test(`${theme} mode at ${width}px has no horizontal overflow and passes accessibility checks`, async ({ page, canvas }, testInfo) => {
      canvas.rows.splice(4);
      canvas.rows[0].subject.title = `A long notification title ${"without-spaces-".repeat(15)}`;
      canvas.rows[0].subject.url = "https://api.github.com/repos/example/widgets/issues/42";
      await canvas.preferences.update({ darkMode: theme === "dark" });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(canvas.url);
      await expect(page.locator(".row")).toHaveCount(4);
      await expect(page.locator("html")).toHaveAttribute("data-notification-theme", theme);
      const search = page.getByRole("searchbox", { name: searchName });
      await expect(search).toHaveAttribute("placeholder", "Search loaded notifications...");
      expect(await search.evaluate(node => {
        const style = getComputedStyle(node);
        const context = document.createElement("canvas").getContext("2d");
        context.font = `${style.fontSize} ${style.fontFamily}`;
        return context.measureText(node.placeholder).width <= node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      })).toBe(true);
      await expect(page.locator(".repo-count")).toHaveText(["3 loaded \u00b7 3 unread", "1 loaded \u00b7 1 unread"]);
      await expect(page.getByRole("button", { name: "Mark 1 as read in example/tools; 1 shown, loaded notifications", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Mark 3 as read in example/widgets; 3 shown, loaded notifications", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "GitHub Notifications", exact: true })).toBeVisible();
      await expect(page.locator(".attention-navigation")).toHaveCSS("margin-top", width <= 360 ? "4px" : "8px");
      if (width <= 480) {
        const rows = await page.locator(".row").evaluateAll(nodes => nodes.map(node => {
          const time = node.querySelector("time").getBoundingClientRect();
          const read = node.querySelector(".mark-read").getBoundingClientRect();
          const done = node.querySelector(".mark-done").getBoundingClientRect();
          const content = node.querySelector(".row-content").getBoundingClientRect();
          return { timeBottom: time.bottom, readTop: read.top, doneTop: done.top, readRight: read.right,
            doneLeft: done.left, readHeight: read.height, doneHeight: done.height, contentBottom: content.bottom,
            metadataContainsTime: node.querySelector(".metadata").contains(node.querySelector("time")) };
        }));
        for (const row of rows) {
          expect(row.metadataContainsTime).toBe(true);
          expect(row.timeBottom).toBeLessThanOrEqual(row.contentBottom);
          expect(row.readTop).toBeLessThan(row.contentBottom);
          expect(row.readTop).toBe(row.doneTop);
          expect(row.readRight).toBeLessThan(row.doneLeft);
          expect(row.readHeight).toBeGreaterThanOrEqual(28);
          expect(row.doneHeight).toBeGreaterThanOrEqual(28);
        }
      }
      await expect(page.locator(".row .title").filter({ hasText: "A long notification title" })).toHaveText(canvas.rows[0].subject.title);
      const inboxLink = page.locator(".toolbar").getByRole("link", { name: "Open GitHub inbox", exact: true });
      await expect(inboxLink).toBeVisible();
      await expect(inboxLink).toHaveAttribute("href", "https://github.com/notifications");
      await expect(page.locator("footer a")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-inbox.png`), fullPage: true });
      await page.getByLabel("Settings", { exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Theme", exact: true })).toBeEnabled();
      const bounds = await page.locator("#settings-panel").boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), fullPage: true });
    });
  }
}

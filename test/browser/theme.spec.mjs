import AxeBuilder from "@axe-core/playwright";
import { test, expect, openSettings } from "./fixtures.mjs";

const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(", ")})`;

async function expectNativeTheme(page, mode, background, foreground) {
  await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
  for (const select of await page.locator("select").all()) {
    await expect(select).toHaveCSS("color-scheme", mode);
    const enhanced = await select.evaluate(node => getComputedStyle(node).appearance === "base-select");
    if (enhanced) {
      // Closed customizable pickers can retain stale computed option styles in WebKit.
      if (!await select.isVisible()) continue;
      if (await select.getAttribute("id") === "desktop-sound" &&
          await page.locator("#desktop-notifications").getAttribute("aria-checked") === "false") {
        await expect(select).toBeDisabled();
        continue;
      }
      await expect(select).toBeEnabled();
      if (!await select.evaluate(node => node.matches(":open"))) await select.click();
      await expect.poll(() => select.evaluate(node => node.matches(":open"))).toBe(true);
    }
    for (const option of await select.locator("option").all()) {
      if (!enhanced || !await option.evaluate(node => node.selected)) {
        await expect(option).toHaveCSS("background-color", rgb(background));
      }
      await expect(option).toHaveCSS("color", rgb(foreground));
    }
    if (enhanced) {
      await page.keyboard.press("Escape");
      await expect.poll(() => select.evaluate(node => node.matches(":open"))).toBe(false);
    }
  }
}

for (const [target, attribute] of [
  ["html", "data-color-mode"], ["body", "data-color-mode"],
  ["html", "data-theme-tone"], ["body", "data-theme-tone"],
]) {
  test(`Match Copilot follows ${target} ${attribute} and palette tokens rather than the OS`, async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(1);
    await openSettings(page);
    const theme = page.getByRole("combobox", { name: "Theme", exact: true });
    await expect(theme.locator("option:checked")).toHaveText("Match Copilot");
    for (const [mode, background, foreground, border, accent, muted] of [
      ["dark", "#18212b", "#fafafa", "#526170", "#79b8ff", "#b2bcc7"],
      ["light", "#f5f6f7", "#202428", "#80868c", "#175aba", "#515960"],
    ]) {
      await page.emulateMedia({ colorScheme: mode === "dark" ? "light" : "dark" });
      await page.evaluate(({ target, attribute, mode, background, foreground, border, accent, muted }) => {
        document.querySelector(target).setAttribute(attribute, mode);
        let defaults = document.getElementById("synthetic-theme-defaults");
        if (!defaults) {
          defaults = document.createElement("style");
          defaults.id = "synthetic-theme-defaults";
          document.head.insertBefore(defaults, document.head.firstChild);
        }
        const variables = Object.entries({
          "--background-color-default": background, "--text-color-default": foreground,
          "--border-color-default": border, "--true-color-blue": accent, "--text-color-muted": muted,
        }).map(([name, value]) => `${name}: ${value};`).join("\n");
        defaults.textContent = `:root { ${variables} }`;
      }, { target, attribute, mode, background, foreground, border, accent, muted });
      await expect(page.locator("html")).not.toHaveAttribute("data-notification-theme");
      await expectNativeTheme(page, mode, background, foreground);
      await expect(page.locator("body")).toHaveCSS("background-color", rgb(background));
      await expect(page.locator("body")).toHaveCSS("color", rgb(foreground));
      await expect(page.locator("#settings-toggle")).toHaveCSS("border-top-color", rgb(border));
      await expect(page.locator(".attention-tab").first()).toHaveCSS("border-bottom-color", rgb(accent));
      await expect(page.locator(".status-line")).toHaveCSS("color", rgb(muted));
      await theme.click();
      await expect(page.locator("#theme:open")).toBeVisible();
      // Axe needs timers; picker-style assertions must not race periodic settings reads.
      await page.clock.resume();
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
      if (await theme.evaluate(node => node.matches(":open"))) await page.keyboard.press("Escape");
      await expect(page.locator("#theme:open")).toHaveCount(0);
      await expect(page.locator("#settings-panel")).toBeVisible();
      await page.evaluate(() => {
        document.getElementById("synthetic-theme-defaults").textContent += ":root { --background-color-default: #213447; }";
      });
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(33, 52, 71)");
      await expectNativeTheme(page, mode, "#213447", foreground);
    }
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(13, 17, 23)");
    await expectNativeTheme(page, "dark", "#0d1117", "#f0f6fc");
    await theme.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "light");
    await expectNativeTheme(page, "light", "#ffffff", "#1f2328");
    await theme.selectOption({ label: "Match Copilot" });
    await expect(page.locator("html")).not.toHaveAttribute("data-notification-theme");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(33, 52, 71)");
    await expectNativeTheme(page, "light", "#213447", "#202428");
    expect((await canvas.preferences.read()).darkMode).toBeNull();
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
  });
}

test("native dropdowns follow OS changes when no Copilot theme is supplied", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  for (const [mode, background, foreground] of [
    ["dark", "#0d1117", "#f0f6fc"],
    ["light", "#ffffff", "#1f2328"],
  ]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", mode);
    await expectNativeTheme(page, mode, background, foreground);
  }
  expect((await canvas.preferences.read()).darkMode).toBeNull();
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

test("customizable dropdowns are rounded, themed and usable beyond the Settings scroll container", async ({ page, canvas }, testInfo) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  for (const theme of ["light", "dark"]) {
    await page.locator("#theme").selectOption(theme);
    for (const [width, height] of [[320, 320], [320, 800], [960, 720]]) {
      await page.setViewportSize({ width, height });
      await grouping.click();
      await expect(page.locator("#group-by:open")).toBeVisible();
      await expect(grouping).toHaveCSS("appearance", "base-select");
      const picker = await grouping.evaluate(node => {
        const style = getComputedStyle(node, "::picker(select)");
        return { radius: style.borderRadius, padding: style.padding, background: style.backgroundColor,
          shadow: style.boxShadow, icon: getComputedStyle(node, "::picker-icon").display };
      });
      expect(picker.radius).toBe("10px");
      expect(picker.padding).toBe("4px");
      expect(picker.background).toBe(theme === "dark" ? "rgb(13, 17, 23)" : "rgb(255, 255, 255)");
      expect(picker.shadow).not.toBe("none");
      expect(picker.icon).toBe("none");
      await expect(grouping.locator("option:checked")).not.toHaveCSS("background-color", picker.background);
      for (const option of await grouping.locator("option").all()) {
        await expect(option).toBeVisible();
        await expect(option).toHaveCSS("border-radius", "6px");
        const box = await option.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(32);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
        expect(await option.evaluate(node => {
          const box = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
      }
      await grouping.locator('option[value="date"]').hover();
      await expect(grouping.locator('option[value="date"]')).not.toHaveCSS("background-color", picker.background);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`dropdown-${theme}-${width}-${height}.png`) });
      await page.keyboard.press("Escape");
      await expect(page.locator("#group-by:open")).toHaveCount(0);
      await expect(page.locator("#settings-panel")).toBeVisible();
    }
  }
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

test("customizable dropdowns preserve keyboard selection, cancellation, focus and pointer dismissal", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  await expect(grouping).toBeEnabled();
  await grouping.focus();
  await grouping.press("Space");
  await expect(page.locator("#group-by:open")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Escape");
  await expect(grouping).toHaveValue("repo");
  await expect(grouping).toBeFocused();
  await expect(page.locator("#settings-panel")).toBeVisible();
  expect((await canvas.preferences.read()).groupBy).toBe("repo");
  await grouping.press("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(grouping).toHaveValue("none");
  await expect(grouping).toBeEnabled();
  await expect(grouping).toBeFocused();
  await expect.poll(async () => (await canvas.preferences.read()).groupBy).toBe("none");
  await grouping.click();
  await grouping.locator('option[value="date"]').click();
  await expect(grouping).toHaveValue("date");
  await expect(grouping).toBeEnabled();
  await expect(grouping).toBeFocused();
  await expect.poll(async () => (await canvas.preferences.read()).groupBy).toBe("date");
  await grouping.click();
  await page.locator("#search").click();
  await expect(page.locator("#group-by:open")).toHaveCount(0);
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(page.locator("#search")).toBeFocused();
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

test("background settings polling preserves focus in the grouping picker", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await page.clock.install();
  let settingsReads = 0;
  page.on("requestfinished", request => {
    if (request.url().endsWith("/api/settings") && request.method() === "GET") settingsReads++;
  });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  const view = page.getByRole("combobox", { name: "Group By", exact: true });
  await expect(view).toBeEnabled();
  await view.focus();
  await view.press("Space");
  await page.keyboard.press("ArrowDown");
  await expect(view.locator('option[value="date"]')).toBeFocused();
  const before = settingsReads;
  await page.clock.runFor(5000);
  await expect.poll(() => settingsReads).toBeGreaterThan(before);
  await expect(view).toBeEnabled();
  // Some webviews retain option focus while others close a briefly disabled picker.
  await expect.poll(() => view.evaluate(node => {
    const active = document.activeElement;
    return active === node || (node.matches(":open") && node.contains(active));
  })).toBe(true);
  if (await view.evaluate(node => node.matches(":open"))) await page.keyboard.press("Escape");
  await expect(view).toBeFocused();
  await expect(view).toHaveValue("repo");
  await expect(page.locator("#settings-panel")).toBeVisible();
  expect((await canvas.preferences.read()).groupBy).toBe("repo");
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

test("long sound pickers scroll without overflowing a short canvas", async ({ page, canvas }) => {
  canvas.rows.splice(1);
  await canvas.preferences.update({ desktopNotifications: true, darkMode: true });
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  const sound = page.getByRole("combobox", { name: "Sound", exact: true });
  await expect(sound).toBeEnabled();
  await sound.click();
  await expect(page.locator("#desktop-sound:open")).toBeVisible();
  expect(await sound.locator("option").count()).toBeGreaterThan(10);
  const last = sound.locator("option").last();
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(320);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  const value = await last.getAttribute("value");
  await last.click();
  await expect(sound).toHaveValue(value);
  await expect(sound).toBeEnabled();
  await expect(sound).toBeFocused();
  await expect.poll(async () => (await canvas.preferences.read()).desktopSound).toBe(value);
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

test("unsupported customizable-select styling keeps the native dropdown fallback", async ({ page, canvas }) => {
  await page.route("**/styles.css", async route => {
    const response = await route.fetch();
    const css = await response.text();
    const guard = "@supports (appearance: base-select) and selector(::picker(select))";
    expect(css).toContain(guard);
    await route.fulfill({ response, body: css.replace(guard, "@supports (appearance: unsupported-select)") });
  });
  canvas.rows.splice(1);
  await canvas.preferences.update({ darkMode: true });
  await page.goto(canvas.url);
  await expect(page.locator(".row")).toHaveCount(1);
  await openSettings(page);
  await expectNativeTheme(page, "dark", "#0d1117", "#f0f6fc");
  const grouping = page.getByRole("combobox", { name: "Group By", exact: true });
  await expect(grouping).toHaveCSS("appearance", "none");
  await grouping.selectOption("date");
  await expect(grouping).toBeEnabled();
  await expect.poll(async () => (await canvas.preferences.read()).groupBy).toBe("date");
  await grouping.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(page.locator("#settings-toggle")).toBeFocused();
  expect(canvas.writes).toEqual([]);
  expect(canvas.deliveries).toEqual([]);
});

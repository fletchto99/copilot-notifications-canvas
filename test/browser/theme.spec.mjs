import { test, expect } from "./fixtures.mjs";

for (const [target, attribute] of [
  ["html", "data-color-mode"], ["body", "data-color-mode"],
  ["html", "data-theme-tone"], ["body", "data-theme-tone"],
]) {
  test(`Match Copilot follows ${target} ${attribute} and palette tokens rather than the OS`, async ({ page, canvas }) => {
    canvas.rows.splice(1);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(canvas.url);
    await expect(page.locator(".row")).toHaveCount(1);
    await page.locator("#settings-toggle").click();
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
        defaults.textContent = `:root { ${variables} color-scheme: ${mode}; }`;
      }, { target, attribute, mode, background, foreground, border, accent, muted });
      await expect(page.locator("html")).not.toHaveAttribute("data-notification-theme");
      await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
      const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(", ")})`;
      await expect(page.locator("body")).toHaveCSS("background-color", rgb(background));
      await expect(page.locator("body")).toHaveCSS("color", rgb(foreground));
      await expect(page.locator("#settings-toggle")).toHaveCSS("border-top-color", rgb(border));
      await expect(page.locator(".attention-tab").first()).toHaveCSS("border-bottom-color", rgb(accent));
      await expect(page.locator(".subtitle")).toHaveCSS("color", rgb(muted));
      await page.evaluate(() => {
        document.getElementById("synthetic-theme-defaults").textContent += ":root { --background-color-default: #213447; }";
      });
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(33, 52, 71)");
    }
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-notification-theme", "dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(13, 17, 23)");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await theme.selectOption({ label: "Match Copilot" });
    await expect(page.locator("html")).not.toHaveAttribute("data-notification-theme");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(33, 52, 71)");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    expect((await canvas.preferences.read()).darkMode).toBeNull();
    expect(canvas.writes).toEqual([]);
    expect(canvas.deliveries).toEqual([]);
  });
}

import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { test, expect } from "./fixtures.mjs";
import { createCanvasFixture } from "../canvas-fixtures.mjs";
import { renderReadmeScreenshot } from "../../scripts/screenshot-readme.mjs";

test("README captures are byte-identical across fresh fixtures and browser contexts", async ({ browser }, testInfo) => {
  const captures = [];
  const fixtures = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    captures.push(await renderReadmeScreenshot(browser, expect, {
      create: async options => {
        const canvas = await createCanvasFixture(options);
        fixtures.push(canvas);
        return canvas;
      },
    }));
  }
  expect(fixtures[0].root).not.toBe(fixtures[1].root);
  expect(fixtures[0].url).not.toBe(fixtures[1].url);
  for (const canvas of fixtures) {
    await expect(stat(canvas.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(new URL(canvas.url).origin)).rejects.toThrow();
  }
  const hashes = captures.map(image => createHash("sha256").update(image).digest("hex"));
  expect(hashes[0], "Identical PNG bytes in the same browser/OS/font environment").toBe(hashes[1]);
  expect(captures[0].readUInt32BE(16)).toBe(1470);
  expect(captures[0].readUInt32BE(20)).toBe(2000);
  await writeFile(testInfo.outputPath("readme.png"), captures[0]);
});

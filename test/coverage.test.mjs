import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import coverageReporter, { assertCoverageIncludes, renderCoverageBadge } from "../scripts/coverage-reporter.mjs";

test("the coverage command enforces at least 95% aggregate coverage and checks source-file inclusion", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const command = manifest.scripts["test:coverage"];
  for (const metric of ["lines", "branches", "functions"]) {
    const threshold = command.match(new RegExp(`--test-coverage-${metric}=(\\d+)(?:\\s|$)`));
    assert.ok(threshold && Number(threshold[1]) >= 95, `The ${metric} coverage gate must be at least 95%`);
  }
  assert.match(command, /--test-reporter=\.\/scripts\/coverage-reporter\.mjs(?:\s|$)/);
});

test("coverage cannot silently omit unexecuted runtime files or count tests in their place", () => {
  const expected = ["extension.mjs", "app.mjs"];
  assert.doesNotThrow(() => assertCoverageIncludes(expected.map(path => ({ path: resolve(path) })), expected));
  assert.throws(() => assertCoverageIncludes([{ path: "test/extension.test.mjs" }, { path: "app.mjs" }], expected),
    /Source files missing from coverage:\nextension\.mjs/);
  assert.throws(() => assertCoverageIncludes([], expected), /extension\.mjs\napp\.mjs/);
});

test("coverage badges show measured line coverage with accessible text and threshold-based colors", () => {
  for (const [percent, value, color] of [
    [0, "0.00%", "#b91c1c"],
    [94.5, "94.50%", "#b91c1c"],
    [95, "95.00%", "#166534"],
    [98.765, "98.77%", "#166534"],
    [100, "100.00%", "#166534"],
  ]) {
    const svg = renderCoverageBadge(percent);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(svg.includes(`role="img" aria-label="Line coverage: ${value}"`));
    assert.ok(svg.includes(`<title>Line coverage: ${value}</title>`));
    assert.ok(svg.includes(`<text x="94.5" y="14">${value}</text>`));
    assert.ok(svg.includes(`fill="${color}"`));
    assert.doesNotMatch(svg, /<script|<image|href=/);
  }
});

test("coverage badge text meets 4.5:1 contrast across both status colors and the gradient", () => {
  const channels = hex => {
    const digits = hex.slice(1);
    const expanded = digits.length === 3 ? [...digits].map(digit => digit.repeat(2)).join("") : digits;
    return expanded.match(/../g).map(channel => parseInt(channel, 16));
  };
  const luminance = rgb => rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);

  for (const percent of [94.5, 95]) {
    const svg = renderCoverageBadge(percent);
    const foreground = channels(svg.match(/<g fill="(#[\da-f]+)" text-anchor=/)[1]);
    assert.match(svg, /<stop offset="0" stop-color="#bbb" stop-opacity="\.1"\/><stop offset="1" stop-opacity="\.1"\/>/);
    for (const background of svg.matchAll(/<path fill="(#[\da-f]+)" d=/g)) {
      for (let step = 0; step <= 100; step++) {
        const overlay = 187 * (1 - step / 100);
        const composited = channels(background[1]).map(channel => channel * 0.9 + overlay * 0.1);
        const light = luminance(foreground);
        const dark = luminance(composited);
        const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
        assert.ok(contrast >= 4.5, `${background[1]} at gradient step ${step}: ${contrast.toFixed(2)}:1`);
      }
    }
  }
});

test("coverage badges reject missing, nonnumeric, and out-of-range measurements", () => {
  for (const percent of [undefined, null, "", "99", NaN, Infinity, -1, 100.1, "<script>"]) {
    assert.throws(() => renderCoverageBadge(percent), /finite percentage between 0 and 100/);
  }
});

async function coverageEvent(percent = 98.765) {
  const paths = [fileURLToPath(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url))];
  for (const directory of ["../src/", "../scripts/"]) {
    const root = new URL(directory, import.meta.url);
    for (const file of await readdir(root)) {
      if (file.endsWith(".mjs") && !["coverage-reporter.mjs", "build-release.mjs"].includes(file)) {
        paths.push(fileURLToPath(new URL(file, root)));
      }
    }
  }
  return {
    type: "test:coverage",
    data: { summary: { files: paths.map(path => ({ path })), totals: { coveredLinePercent: percent } } },
  };
}

async function report(events, badgePath = null) {
  let output = "";
  for await (const chunk of coverageReporter(events, { badgePath })) output += chunk;
  return output;
}

test("the reporter writes a badge only when requested and preserves its source-inclusion check", async t => {
  const directory = await mkdtemp(join(tmpdir(), "coverage-badge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badgePath = join(directory, "coverage.svg");
  const event = await coverageEvent();
  const output = await report([{ type: "test:start" }, event]);
  assert.match(output, /^Coverage includes all \d+ runtime and release\/installer source files\.\n$/);
  await assert.rejects(readFile(badgePath), { code: "ENOENT" });
  assert.equal(await report([event], badgePath), output);
  assert.equal(await readFile(badgePath, "utf8"), renderCoverageBadge(98.765));

  const missingPath = join(directory, "missing.svg");
  event.data.summary.files.pop();
  await assert.rejects(report([event], missingPath), /Source files missing from coverage/);
  await assert.rejects(readFile(missingPath), { code: "ENOENT" });
});

test("the reporter fails explicitly for absent coverage, invalid totals, and unwritable output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "coverage-badge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badgePath = join(directory, "coverage.svg");
  await assert.rejects(report([{ type: "test:pass" }], badgePath), /did not emit a coverage report/);
  const event = await coverageEvent();
  await assert.rejects(report([event], join(directory, "missing", "coverage.svg")), { code: "ENOENT" });
  delete event.data.summary.totals;
  await assert.rejects(report([event], badgePath), /finite percentage/);
  await assert.rejects(readFile(badgePath), { code: "ENOENT" });
});

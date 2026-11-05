import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertCoverageIncludes(files, expected) {
  const covered = new Set(files.map(file => resolve(file.path)));
  const missing = expected.filter(path => !covered.has(resolve(path)));
  if (missing.length) throw new Error(`Source files missing from coverage:\n${missing.join("\n")}`);
}

export function renderCoverageBadge(percent) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Line coverage must be a finite percentage between 0 and 100.");
  }
  const value = `${percent.toFixed(2)}%`;
  const color = percent >= 95 ? "#166534" : "#b91c1c";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="126" height="20" role="img" aria-label="Line coverage: ${value}">
  <title>Line coverage: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="126" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <path fill="#555" d="M0 0h63v20H0z"/>
    <path fill="${color}" d="M63 0h63v20H63z"/>
    <path fill="url(#s)" d="M0 0h126v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="31.5" y="15" fill="#010101" fill-opacity=".3">coverage</text>
    <text x="31.5" y="14">coverage</text>
    <text x="94.5" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="94.5" y="14">${value}</text>
  </g>
</svg>
`;
}

export default async function* coverageReporter(events, { badgePath = process.env.COVERAGE_BADGE_PATH } = {}) {
  const runtime = new URL("../src/", import.meta.url);
  const scripts = new URL("./", import.meta.url);
  const expected = [fileURLToPath(new URL("../.github/extensions/github-notifications/extension.mjs", import.meta.url))];
  for (const directory of [runtime, scripts]) {
    for (const file of await readdir(directory)) {
      if (file.endsWith(".mjs") && !["coverage-reporter.mjs", "build-release.mjs"].includes(file)) {
        expected.push(fileURLToPath(new URL(file, directory)));
      }
    }
  }
  let reported = false;
  for await (const event of events) {
    if (event.type !== "test:coverage") continue;
    assertCoverageIncludes(event.data.summary.files, expected);
    if (badgePath) {
      await writeFile(badgePath, renderCoverageBadge(event.data.summary.totals?.coveredLinePercent));
    }
    reported = true;
    yield `Coverage includes all ${expected.length} runtime and release/installer source files.\n`;
  }
  if (!reported) throw new Error("The test runner did not emit a coverage report.");
}

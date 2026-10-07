import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertCoverageIncludes(files, expected) {
  const covered = new Set(files.map(file => resolve(file.path)));
  const missing = expected.filter(path => !covered.has(resolve(path)));
  if (missing.length) throw new Error(`Source files missing from coverage:\n${missing.join("\n")}`);
}

export default async function* coverageReporter(events) {
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
    reported = true;
    yield `Coverage includes all ${expected.length} runtime and release/installer source files.\n`;
  }
  if (!reported) throw new Error("The test runner did not emit a coverage report.");
}

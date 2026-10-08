import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvasFixture } from "../test/canvas-fixtures.mjs";
import { getPreviewScenario, previewScenarios } from "../test/preview-scenarios.mjs";
import { CURRENT_VERSION } from "../src/updates.mjs";

export const previewUsage = `Usage: npm run dev:fixture -- [--scenario=<name>]
       npm run dev:fixture -- --help

Scenarios:
${Object.entries(previewScenarios).map(([name, preset]) => `  ${name}: ${preset.description}`).join("\n")}
`;

export function parsePreviewArgs(args) {
  if (args.length === 0) return { scenario: "populated" };
  if (args.length === 1 && args[0] === "--help") return { help: true };
  let scenario;
  if (args.length === 1 && args[0].startsWith("--scenario=")) {
    scenario = args[0].slice("--scenario=".length);
  } else if (args.length === 2 && args[0] === "--scenario") {
    scenario = args[1];
  } else {
    throw new Error(`Invalid preview arguments.\n${previewUsage}`);
  }
  getPreviewScenario(scenario);
  return { scenario };
}

export async function startPreview({
  scenario = "populated", create = createCanvasFixture, write = writeFile,
  log = message => process.stderr.write(`${message}\n`),
} = {}) {
  const preset = getPreviewScenario(scenario);
  const canvas = await create({
    development: { version: CURRENT_VERSION, branch: `synthetic preview (${scenario}) - temporary settings, simulated alerts` },
    log,
  });
  try {
    const reasons = ["review_requested", "mention", "team_mention", "assign", "author", "comment", "subscribed"];
    for (const [index, row] of canvas.rows.entries()) row.reason = reasons[index % reasons.length];
    preset.configure(canvas);
    const launcher = join(canvas.root, "preview.html");
    await write(launcher, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="refresh" content="0; url=${canvas.url}">
  <title>Synthetic notifications preview</title>
</head>
<body><p><a href="${canvas.url}">Open the synthetic notifications preview</a>.</p></body>
</html>
`, { flag: "wx", mode: 0o600 });
    return { ...canvas, scenario, launcher: pathToFileURL(launcher).href };
  } catch (error) {
    await canvas.close();
    throw error;
  }
}

export async function runPreview({
  scenario = "populated", start = startPreview, signals = process, write = text => process.stdout.write(text),
} = {}) {
  let canvas;
  let stopping = false;
  let stop;
  const stopped = new Promise(resolve => {
    stop = () => { stopping = true; resolve(); };
  });
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  try {
    canvas = await start({ scenario });
    if (!stopping) {
      write(`Synthetic notifications preview: ${scenario} (no GitHub requests or native alerts).\nOpen this private launcher in your browser:\n${canvas.launcher}\nThe capability URL stays in the temporary launcher, not terminal output.\nPress Ctrl+C to stop and remove temporary settings.\n`);
    }
    await stopped;
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    await canvas?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options;
  try {
    options = parsePreviewArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  if (options?.help) {
    process.stdout.write(previewUsage);
  } else if (options) {
    try {
      await runPreview(options);
    } catch (error) {
      process.stderr.write(`Synthetic preview failed (${error.code ?? error.name}). Check local file and loopback permissions.\n`);
      process.exitCode = 1;
    }
  }
}

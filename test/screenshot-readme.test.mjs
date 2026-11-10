import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  generateReadmeScreenshot, parseScreenshotArgs, readmeImage, renderReadmeScreenshot, runScreenshot, screenshotUsage,
} from "../scripts/screenshot-readme.mjs";
import { createCanvasFixture } from "./canvas-fixtures.mjs";
import { readmeContext, readmePreferences, readmeRepositories, readmeRows, readmeTime } from "./readme-fixture.mjs";

test("README arguments default to the repository image and allow only one PNG output or help", () => {
  assert.deepEqual(parseScreenshotArgs([]), { output: readmeImage });
  assert.deepEqual(parseScreenshotArgs(["--help"]), { help: true });
  assert.deepEqual(parseScreenshotArgs(["--output=image.png"]), { output: resolve("image.png") });
  assert.deepEqual(parseScreenshotArgs(["--output", "image.PNG"]), { output: resolve("image.PNG") });
  for (const args of [
    ["--output"], ["--output="], ["--output=image.jpg"], ["image.png"], ["--live"],
    ["--help", "extra"], ["--output=a.png", "--output=b.png"], ["--output", "a.png", "extra"],
  ]) assert.throws(() => parseScreenshotArgs(args), /Usage: npm run screenshot:readme/);
});

test("README scene returns fresh fixed rows, three example repositories, and mixed read/state data", () => {
  const rows = readmeRows();
  assert.equal(rows.length, 10);
  assert.equal(rows.filter(row => row.unread).length, 7);
  assert.deepEqual([...new Set(rows.map(row => row.repository.full_name))], readmeRepositories);
  assert.equal(new Set(rows.map(row => row.id)).size, 10);
  assert.deepEqual(rows.map(row => (readmeTime - Date.parse(row.updated_at)) / 60_000),
    [4, 18, 30, 42, 60, 120, 180, 240, 300, 1440]);
  assert.equal(rows[0].mergeQueued, true);
  assert.equal(rows[3].subjectDetails.merged, true);
  assert.equal(rows[4].subjectDetails.draft, true);
  assert.equal(rows[5].subjectDetails.closed, true);
  assert.equal(rows[7].subjectDetails.conclusion, "failure");
  assert.equal(rows[9].subjectDetails.isAnswered, true);
  rows[0].subject.title = "changed";
  rows[0].subjectDetails.state = "changed";
  assert.notDeepEqual(readmeRows()[0], rows[0]);
});

test("README fixture serves the frozen inbox through the protected server with temporary preferences", async t => {
  const canvas = await createCanvasFixture({ development: false, now: () => readmeTime });
  t.after(() => canvas.close());
  canvas.rows.splice(0, canvas.rows.length, ...readmeRows());
  await canvas.preferences.update(readmePreferences);
  assert.deepEqual(await canvas.preferences.read(), { ...readmePreferences, terminalNotifierHintDismissed: false, desktopSound: "default" });
  const { origin, hash } = new URL(canvas.url);
  const response = await fetch(`${origin}/api/refresh`, {
    method: "POST", headers: {
      Origin: origin, Authorization: `Bearer ${hash.slice(1)}`, "Content-Type": "application/json",
    }, body: "{}",
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.status, "ready");
  assert.equal(state.loaded, 10);
  assert.equal(state.hasMore, false);
  assert.equal(state.development, false);
  assert.equal(state.lastFetchedAt, readmeTime);
  assert.deepEqual(state.groups.map(group => group.repository), readmeRepositories);
  assert.deepEqual(state.groups.flatMap(group => group.items).map(row => row.title), readmeRows().map(row => row.subject.title));
  assert.equal(canvas.advance(1000), readmeTime + 1000);
  assert.deepEqual(canvas.writes, []);
  assert.deepEqual(canvas.deliveries, []);
  assert.deepEqual(canvas.errors, []);
  await canvas.close();
  await assert.rejects(stat(canvas.root), { code: "ENOENT" });
  await assert.rejects(fetch(origin));
});

test("capture cleans up temporary fixtures when preferences, context creation, or page creation fails", async () => {
  for (const stage of ["preferences", "context", "page", "context-close"]) {
    let fixtureClosed = false;
    let contextClosed = false;
    const fail = () => { throw new Error(stage); };
    const canvas = {
      rows: [], url: "http://127.0.0.1:12345/#private",
      preferences: { update: stage === "preferences" ? fail : async () => {} },
      close: async () => { fixtureClosed = true; },
    };
    const context = {
      route: async () => {},
      newPage: fail,
      close: async () => { contextClosed = true; if (stage === "context-close") fail(); },
    };
    const browser = { newContext: async options => {
      assert.deepEqual(options, readmeContext);
      if (stage === "context") fail();
      return context;
    } };
    await assert.rejects(renderReadmeScreenshot(browser, null, { create: async options => {
      assert.equal(options.development, false);
      assert.equal(options.now(), readmeTime);
      return canvas;
    } }), new RegExp(stage));
    assert.equal(fixtureClosed, true);
    assert.equal(contextClosed, ["page", "context-close"].includes(stage));
  }
});

test("generation persists only after rendering and browser cleanup succeed", async () => {
  const image = Buffer.from("synthetic PNG");
  for (const stage of ["success", "load", "launch", "render", "close", "write"]) {
    const calls = [];
    const step = name => {
      calls.push(name);
      if (stage === name) throw new Error(stage);
    };
    const browser = { version: () => "123", close: async () => step("close") };
    const generate = () => generateReadmeScreenshot({
      output: "output.png",
      load: async () => {
        step("load");
        return { chromium: { launch: async options => {
          assert.deepEqual(options, { headless: true });
          step("launch");
          return browser;
        } }, expect: "assertions" };
      },
      render: async (value, expect) => {
        assert.equal(value, browser);
        assert.equal(expect, "assertions");
        step("render");
        return image;
      },
      write: async (path, content) => {
        assert.equal(path, "output.png");
        assert.equal(content, image);
        step("write");
      },
    });
    if (stage === "success") {
      assert.deepEqual(await generate(), { output: "output.png", version: "123" });
      assert.deepEqual(calls, ["load", "launch", "render", "close", "write"]);
    } else {
      await assert.rejects(generate(), new RegExp(stage));
      if (["render", "close", "write"].includes(stage)) assert.ok(calls.includes("close"));
      if (stage !== "write") assert.ok(!calls.includes("write"));
    }
  }
});

test("command reports help, success, usage and sanitized failures without exposing capability URLs", async () => {
  for (const args of [["--help"], ["--invalid"], [], ["--output=example.png"]]) {
    let output = "";
    let errors = "";
    const code = await runScreenshot(args, {
      generate: async options => {
        assert.ok(!args.includes("--help") && !args.includes("--invalid"));
        return { output: options.output, version: "123" };
      },
      out: text => { output += text; }, error: text => { errors += text; },
    });
    assert.equal(code, args.includes("--invalid") ? 1 : 0);
    if (args.includes("--help")) assert.equal(output, screenshotUsage);
    else if (args.includes("--invalid")) assert.equal(errors, screenshotUsage);
    else assert.match(output, /Saved synthetic README screenshot:.*\nChromium 123;.*Settings closed/);
  }
  for (const failure of [new Error("http://127.0.0.1:12345/#private"), Object.assign(new Error("private"), { code: "ENOENT" })]) {
    let errors = "";
    const code = await runScreenshot([], {
      generate: async () => { throw failure; },
      out: () => assert.fail("A failed capture must not report success"),
      error: text => { errors += text; },
    });
    assert.equal(code, 1);
    assert.match(errors, new RegExp(`failed \\(${failure.code ?? failure.name}\\)`));
    assert.match(errors, /npx playwright install chromium/);
    assert.doesNotMatch(errors, /127\.0\.0\.1|private/);
  }
});

test("the actual screenshot entry point supports dependency-free help", async () => {
  const result = await promisify(execFile)(process.execPath, ["scripts/screenshot-readme.mjs", "--help"]);
  assert.equal(result.stdout, screenshotUsage);
  assert.equal(result.stderr, "");
});

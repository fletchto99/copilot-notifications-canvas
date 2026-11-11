import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateIcons, iconNames, renderIcons } from "../scripts/generate-icons.mjs";

function fixture() {
  const path = d => ({ name: "path", attributes: { d }, children: [] });
  const variant = { width: 24, ast: { children: [path("M0 0h24v24H0Z"), path("M2 2h2v2H2Z")] } };
  return {
    icons: Object.fromEntries([...iconNames, "unused"].map(name => [name, { heights: {
      16: { width: 16, ast: { children: [path("M0 0h16v16H0Z")] } },
      24: structuredClone(variant),
    } }])),
    version: "1.2.3",
    license: "MIT License\n\nSynthetic test license.\n",
  };
}

test("icon generation selects 24px rather than 16px artwork and preserves separate paths and the upstream license", async () => {
  const data = fixture();
  data.icons.agent.heights[24].width = 30;
  const content = renderIcons(data);
  const generated = await import(`data:text/javascript,${encodeURIComponent(content)}`);
  assert.deepEqual(Object.keys(generated.octicons), iconNames);
  assert.deepEqual(generated.octicons.agent, { width: 30, paths: ["M0 0h24v24H0Z", "M2 2h2v2H2Z"] });
  assert.match(content, /@primer\/octicons@1\.2\.3/);
  assert.match(content, /\/\*!\n \* MIT License\n \*\n \* Synthetic test license\.\n \*\//);
  assert.equal(renderIcons(data), content);
});

test("upstream icons missing a selected variant or changing SVG structure fail rather than losing artwork", () => {
  for (const change of [
    data => delete data.icons.agent,
    data => delete data.icons.agent.heights[24],
    data => { data.icons.agent.heights[24].width = 0; },
    data => { data.icons.agent.heights[24].ast.children = []; },
    data => { data.icons.agent.heights[24].ast.children[0].name = "circle"; },
    data => { data.icons.agent.heights[24].ast.children[0].children.push({}); },
    data => { data.icons.agent.heights[24].ast.children[0].attributes.transform = "translate(1 1)"; },
    data => { data.icons.agent.heights[24].ast.children[0].attributes.d = ""; },
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => renderIcons(data), /Octicon agent (?:is missing|has unsupported SVG markup)/);
  }
});

test("generation writes reproducible output and check mode detects drift without modifying files", async () => {
  const data = fixture();
  let written;
  const options = {
    load: async () => data,
    write: async (url, content) => { written = { url, content }; },
  };
  await generateIcons(options);
  assert.equal(written.url.pathname.endsWith("/src/renderer/octicons.mjs"), true);
  assert.equal(written.content, renderIcons(data));
  const check = { ...options, check: true, write: async () => assert.fail("Check must never write") };
  await generateIcons({ ...check, read: async () => written.content });
  await generateIcons({ ...check, read: async () => written.content.replaceAll("\n", "\r\n") });
  await assert.rejects(generateIcons({ ...check, read: async () => "stale" }), /npm run icons:generate/);
  const missing = Object.assign(new Error("Missing generated file"), { code: "ENOENT" });
  await assert.rejects(generateIcons({ ...check, read: async () => { throw missing; } }), { code: "ENOENT" });
  data.version = "1.2.4";
  await assert.rejects(generateIcons({ ...check, read: async () => written.content }), /Generated Octicons are stale/);
  await assert.rejects(generateIcons({ ...options, write: async () => { throw new Error("Write failed"); } }), /Write failed/);
});

test("the generator rejects unknown and duplicate CLI options before loading dependencies", async () => {
  for (const args of [["--unknown"], ["--check", "--check"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, ["scripts/generate-icons.mjs", ...args]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Icon generation stopped: Usage:/);
      return true;
    });
  }
});

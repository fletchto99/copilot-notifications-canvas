import assert from "node:assert/strict";
import { syntheticTriage } from "../triage-fixtures.mjs";

export const RuntimeConnection = { forStdio: options => ({ kind: "stdio", ...options }) };
export class CopilotClient {
  constructor(options) {
    assert.equal(options.mode, "empty");
    assert.equal(options.logLevel, "none");
  }
  async createSession(options) {
    assert.deepEqual(options.excludedTools, ["builtin:*", "mcp:*"]);
    assert.equal(options.enableSessionStore, false);
    return {
      rpc: { tools: {
        initializeAndValidate: async () => {},
        getCurrentMetadata: async () => ({ tools: options.tools.map(({ name }) => ({ name })) }),
      } },
      sendAndWait: async () => ({ data: { content: JSON.stringify(await syntheticTriage({ tools: options.tools })) } }),
    };
  }
  async stop() { return []; }
}

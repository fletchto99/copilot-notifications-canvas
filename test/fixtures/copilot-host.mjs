import { CopilotHost } from "../../src/copilot.mjs";

export const projectId = "11111111-1111-4111-8111-111111111111";
export const sessionId = "22222222-2222-4222-8222-222222222222";
export const toolNames = [
  "list_repositories", "list_sessions_and_chats", "get_session", "navigate_to", "send_session_message",
  "create_session", "add_repository",
];

export function copilotHost({ repositories = [{ id: projectId, github_repo: "example/widgets" }], sessions = [], tools = toolNames, onExecute, log } = {}) {
  const calls = [];
  const rpc = {
    getCurrentMetadata: async () => ({ tools: tools.map(name => ({
      name, ...(name === "create_session" ? { input_schema: { properties: {
        name: { type: "string", maxLength: 40 },
        detached: { type: "boolean" },
        kickoff: { type: "object", properties: {
          prompt: { type: "string" }, mode: { type: "string", enum: ["plan", "interactive", "autopilot"] },
        }, required: ["prompt"] },
      } } } : {}),
    })) }),
    execute: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      const intercepted = await onExecute?.(name, args);
      if (intercepted !== undefined) return intercepted;
      let text = "Completed.";
      if (name === "list_repositories") text = `Found ${repositories.length} configured container(s):\n${JSON.stringify(repositories)}`;
      if (name === "list_sessions_and_chats") text = `Found ${sessions.length} item(s):\n${JSON.stringify(sessions)}`;
      if (name === "get_session") text = JSON.stringify({ id: args.project_session_id, activity: { status: "unknown" } });
      if (name === "add_repository") repositories.push({ id: projectId, github_repo: args.github_repo });
      if (name === "create_session") {
        if (typeof args.name !== "string" || args.name.length > 40) {
          return { resultType: "failure", textResultForLlm: "Synthetic session name exceeds the host limit." };
        }
        sessions.push({
          type: "session", id: sessionId, name: args.name,
          project_repo: repositories.find(repo => repo.id === args.project_id)?.github_repo,
          parent_session_id: args.detached ? null : "33333333-3333-4333-8333-333333333333",
          activity: { status: "unknown" },
        });
        text = `Created session (session_id: ${sessionId}). Link: ghapp://sessions/${sessionId}.`;
      }
      return { resultType: "success", textResultForLlm: text };
    },
  };
  const host = new CopilotHost(() => ({ rpc: { tools: rpc } }), { log });
  return { host, calls, rpc, repositories, sessions };
}

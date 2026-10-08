import { http } from "./fixtures.mjs";

function notificationRead(args) {
  return args.includes("GET") && args.at(-1).startsWith("/notifications?");
}

export const previewScenarios = {
  populated: {
    description: "Populated inbox with pagination and multiple attention categories (default).",
    configure() {},
  },
  empty: {
    description: "Successful empty inbox.",
    configure(canvas) {
      canvas.rows.length = 0;
    },
  },
  "long-titles": {
    description: "Long wrapping and unbroken titles, plus a long repository name.",
    configure(canvas) {
      canvas.rows[0].subject.title = "Synthetic long title with many words ".repeat(30).trim();
      canvas.rows[1].subject.title = `Synthetic unbroken title ${"x".repeat(512)}`;
      for (const row of canvas.rows.slice(0, 2)) {
        row.repository.full_name = `example/${"long-repository-name-".repeat(8)}widgets`;
      }
    },
  },
  "rate-limited": {
    description: "HTTP 429 on notification reads with an initial 120-second retry wait.",
    configure(canvas) {
      canvas.setRequestHook(args => notificationRead(args)
        ? http({ message: "Synthetic rate limit" }, { "retry-after": "120" }, 429) : undefined);
    },
  },
  stale: {
    description: "First notification read succeeds; use Force refresh to see HTTP 503 with retained rows.",
    configure(canvas) {
      let loaded = false;
      canvas.setRequestHook(args => {
        if (!notificationRead(args)) return;
        if (loaded) return http({ message: "Synthetic service unavailable" }, {}, 503);
        loaded = true;
      });
    },
  },
};

export function getPreviewScenario(name) {
  if (!Object.hasOwn(previewScenarios, name)) {
    throw new Error(`Unknown preview scenario. Choose: ${Object.keys(previewScenarios).join(", ")}.`);
  }
  return previewScenarios[name];
}

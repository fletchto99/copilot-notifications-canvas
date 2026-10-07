# Copilot instructions

Read and follow [AGENTS.md](../AGENTS.md) before making changes. It is the shared
source for repository architecture, implementation conventions, privacy and
state-management invariants, validation commands, and release safeguards.
Keep shared instructions there rather than duplicating them in this file.

Quick orientation:

- Edit `src/`; `.github/extensions/github-notifications/extension.mjs` is only
  the development discovery shim. Do not edit generated or installed bundles.
- Use Node.js 22 or later and ES modules. The Copilot SDK is host-provided.
- Start with relevant `node --test` tests. Use the validation section in
  `AGENTS.md` to select lint, browser, coverage, and packaged checks.
- Keep notification content out of agent results and logs. Validate with
  synthetic fixtures, not live notification writes or real desktop alerts.
- Consult the [README](../README.md) for user-facing behavior, the
  [installation guide](../docs/installation.md) for setup safeguards, and the
  [development guide](../docs/development.md) for development and releases.

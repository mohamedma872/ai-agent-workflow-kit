# Changelog

## Unreleased

- Added Context7 to the project MCP example and a narrow `docs-researcher` Claude subagent for current, version-specific external documentation.
- Added reusable `current-docs` skill/rule so version-sensitive planning and implementation produce a focused `05-analysis/docs-researcher.md` artifact instead of relying on model memory.
- Replaced the example third-party Jira MCP with official Atlassian Rovo MCP v2 for Jira/Confluence context.
- Added role-scoped MCP metadata to the feature workflow and `ai/mcp/README.md` with least-privilege guidance for GitHub, Playwright and Appium.
- Standardized native mobile QA on Appium MCP and added a reusable `mobile-device-qc` skill for AC-driven Android/iOS validation with device evidence.

## 0.3.1 — 2026-09-16

- The exam on autopilot: `ai/evals/auto.js` — `check` (free: guard check + self-test + oracle/null of every case), `live` (the live exam in its own git worktree, cost and time caps, report + notification), `nightly` (check then live), `schedule install|status|run-now|uninstall` (a macOS launchd job), `report`. `npm run exam:check` in CI and the suggested `.husky/pre-push` gate.
- `ai/workflows/feature.yaml`: analysis and review artifacts are named after the subagent (`05-analysis/mobile-architect.md`, `09-reviews/code-reviewer.md`, …) — the names `ai/tasks/feature/cases.yaml` and `ai/README.md` § 14 already expected.
- `ai/README.md` § 6.7 documents the autopilot; § 2 lists it.

## 0.3.0 — 2026-09-16

- Added a provider-independent workflow DAG in `ai/workflows/feature.yaml` and a generic role router in `ai/workflow/router.js`.
- Claude Code remains the `/feature` orchestrator while implementation and fix roles default to Codex with Claude fallback.
- Added `codex-delegate` MCP server: Claude passes run-artifact paths instead of large inline prompts; Codex writes detailed results back to `ai/runs/<id>/` and MCP returns compact status metadata.
- Rebuilt the root README with architecture, workflow, guardrail, MCP token-saving, approval-gate and eval diagrams.
- Hardened the feature approval gate against direct shell mutation of `plan.approved` / `ai/runs/_active` and denied common Git hook-bypass commands.
- Added CI validation for package installation, syntax, guard self-tests, workflow routing and MCP SDK imports.
- Runtime requirement is now Node.js 20+ for the MCP TypeScript SDK v2 server package.

## 0.2.0 — 2026-09-15

- Cursor support removed: the agents are Claude Code and Codex.
- Codex CLI measured (0.154): it ignores an "ask" answer, so the hook runs the engine with `--agent codex` and every ask becomes a deny; patch text is read from `tool_input.command`; exec flags updated; token usage recorded.
- Harness: files written into gitignored paths are caught and cleaned; a non-zero agent exit is "incomplete", not a miss; phantoms count only report-style signatures.

## 0.1.0 — 2026-09-15

- First public version: fence (YAML rules + engine + Cursor adapter + git hooks),
  exam (runner + end-state grader, `--agent claude|cursor|codex`), `/feature`
  workflow with seven read-only specialists and an enforced plan gate,
  `coding` and `feature` example tasks, task template.

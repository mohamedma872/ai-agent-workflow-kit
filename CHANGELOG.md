# Changelog

## Unreleased

- Added Context7 to the project MCP example and a narrow `docs-researcher` Claude subagent for current, version-specific external documentation.
- Added reusable `current-docs` skill/rule so version-sensitive planning and implementation produce a focused `05-analysis/docs.md` artifact instead of relying on model memory.
- Replaced the example third-party Jira MCP with official Atlassian Rovo MCP v2 for Jira/Confluence context.
- Added role-scoped MCP metadata to the feature workflow and `ai/mcp/README.md` with least-privilege guidance for GitHub, Sentry, Playwright, Appium and Maestro.

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

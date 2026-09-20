# Changelog

## Unreleased

- No unreleased runtime changes.

## 1.4.0 — 2026-09-20

- Added the first standalone `agentic` CLI facade for existing Android, iOS, React Native, Flutter, frontend, backend, and generic Git repositories.
- Added explicit separation between runtime root, target project root, product worktree, and workflow state root so an installed runtime no longer assumes its own repository is the product.
- Added `agentic init` with lightweight `.agentic/` project configuration, state/worktree gitignore entries, stack detection, and a Codex guard-hook adapter.
- Added CLI commands for doctor, feature, resume, approve, progress, local refactor, whole-app refactor, architecture selection, reports, Hybrid RAG, worktree inspection/cleanup, and versioning.
- Added a session-scoped Claude settings adapter so standalone workflows use runtime guardrails without copying Claude runtime files into the target project.
- Added `agentic guard-hook` so external-project Claude/Codex hooks call the installed runtime guard policy while decisions are evaluated against the product worktree.
- Hardened human gates so agents cannot invoke `agentic approve` or `agentic architecture` themselves.
- Moved standalone run state to `.agentic-runs/` and isolated worktrees to `.ai-worktrees/` in the target repository; neither is part of application build dependencies.
- Added external-project self-tests proving state/worktree isolation from the installed runtime.

## 1.3.0 — 2026-09-20

- Added role-aware Hybrid RAG context retrieval for repository-reading workflow agents.
- Added keyword/BM25-style scoring, lexical-vector similarity, exact symbol matching, path/metadata relevance, phrase matching, role-aware hints, and an optional semantic-embedding scoring channel.
- Added deterministic reranking, per-file diversity, excerpt limits, and a total context budget so agents receive focused evidence instead of repository dumps.
- Added source path and line-range provenance to every retrieved context item and persisted per-role retrieval packs under `ai/runs/<run-id>/engine/rag-context/`.
- Added sensitive-file exclusion for environment files, credentials/secrets, private keys, keystores, and platform service credential files.
- Added an explicit prompt-injection boundary: retrieved repository text is treated as untrusted evidence, never runtime instructions.
- Added `workflow:rag` and `workflow:rag:selftest` commands plus CI coverage for retrieval, semantic-channel injection, sensitive-file filtering, and subagent context integration.

## 1.2.0 — 2026-09-19

- Added whole-app behavior-preserving refactor scope and the simplified `refactor:app` command.
- Added evidence-backed architecture assessment covering product/business drivers, quality attributes, technical constraints, team/ownership, delivery/operations, security/compliance, data/integrations, testing, migration constraints, risks, unknowns, and weighted decision criteria.
- Added 2-4 architecture alternatives with explicit trade-offs, migration effort/reversibility, cross-functional impact, common criteria scoring, C4 previews, and an advisory agent recommendation.
- Added a mandatory human architecture-selection gate; the agent cannot choose the target architecture on behalf of the human.
- Added a selected target-architecture contract with dependency rules, module boundaries, data ownership, security/observability/testing requirements, performance budgets, migration guardrails, and architecture fitness functions.
- Added C4 architecture modeling with System Context and Container views, targeted Component views, optional Dynamic/Deployment views, and version-controlled Structurizr DSL.
- Added deterministic promotion of selected architecture artifacts into `docs/architecture/` in the refactor worktree so architecture-as-code participates in Git review.
- Added dependency/risk-aware architecture migration domains, waves, integration checkpoints, rollback points, and completion criteria.
- Added an independent post-implementation architecture-compliance review before behavior-equivalence verification.
- Extended final refactor reports with the human architecture decision, recommendation-vs-selection, C4/model statistics, migration waves, fitness functions, and architecture compliance findings.

## 1.1.0 — 2026-09-19

- Added first-class behavior-preserving refactor mode with deterministic intent detection and explicit `--mode refactor` override.
- Added structured behavior baseline and preservation-invariant artifacts before refactor planning.
- Added characterization/golden-master coverage gating for critical/high behaviors, with explicit owner/reason risk waivers.
- Added ordered refactor increments with mandatory per-increment diff/test checkpoint evidence.
- Added a scope-aware verification matrix for logic, repository/API, navigation, persistence, UI/state, native bridge, and device validation.
- Added an independent behavior-regression reviewer focused on runtime behavior rather than style.
- Added a final behavior-equivalence gate that rejects unexpected changes and prevents full-verification claims while scenarios remain unverified.
- Added deterministic before/after contract checks for public/API, navigation, storage key/format, analytics, error, concurrency, and lifecycle behavior.
- Added full-vs-partial refactor verification metadata to GitHub status summaries.
- Added refactor-specific JSON/Markdown reporting and behavior telemetry.
- Added adversarial refactor evals for login semantics, persistence compatibility, async ordering, navigation/deep links, analytics, and null/default behavior.

## 1.0.0 — 2026-09-17

- Established the private **AI Agent Workflow Runtime** as a deterministic runtime distinct from the original prompt-driven workflow kit.
- Added a deterministic workflow engine that owns DAG progression, dependency enforcement, controlled state transitions, human approval, conditional roles, pause/resume, and scope-aware execution.
- Added automatic workflow doctor preflight with mobile/frontend/backend scope handling and optional unrelated-stack prerequisites.
- Added bounded retry, timeout, failure classification, executor fallback, and persistent attempt history with resume-safe behavior.
- Added isolated per-run git worktrees, explicit multi-run identity, safe cleanup, and removal of `_active` as an authoritative execution dependency.
- Added stronger plan-gate shell-write detection plus fail-closed guard supervision for protected/destructive operations.
- Added first-class Flutter support and selective Android/iOS/Flutter/frontend/backend specialists.
- Added executable Appium Android/iOS evidence, current-attempt freshness checks, real session metadata, exact APK/AAB/IPA/.app hashing, workspace/commit identity, screenshot/manifest hashes, and runtime-owned `evidence.json` attestation.
- Added versioned structured JSON artifacts for acceptance criteria, plan, build/test, reviews, verification, and evidence; these are now executable workflow gates rather than documentation-only schemas.
- Added commit-bound `agentic-workflow-verification` GitHub status publishing with a sanitized allowlisted summary and stale/SHA/evidence mismatch rejection.
- Expanded eval coverage across React Native, Android, iOS, Flutter, backend, frontend, Appium/device unavailability, partial/stale evidence, state-forging, guard weakening, retry/resume/fallback, and concurrent worktree isolation.
- Added deterministic runtime-hardening regression checks to `exam:check`/`exam:nightly`.
- Added runtime SemVer and independent workflow/artifact compatibility versions, release checks, migration notes, annotated tag tooling, and tag-driven GitHub Release automation.

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

- First public version: fence (YAML rules + engine + Cursor adapter + git hooks), exam (runner + end-state grader, `--agent claude|cursor|codex`), `/feature` workflow with seven read-only specialists and an enforced plan gate, `coding` and `feature` example tasks, task template.

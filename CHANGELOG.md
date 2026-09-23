# Changelog

## Unreleased

- No unreleased runtime changes.

## 1.8.0 — 2026-09-23

- Added `c` in the dashboard to close the highlighted feature, so abandoned runs can leave the in-progress list without hand-editing state. It always asks first: only `y` confirms, any other key cancels, and `ctrl-c` still quits.
- Closing a run before verification passes is now recorded as an abandon: `state.json` gets `abandoned: true` and `closedReason`, and the run history gets an `abandon` entry with the reason and actor. A verified run closes exactly as before.
- `agentic runs --all` and the dashboard now show abandoned runs as `abandoned` instead of `done`.
- The verification gate is unchanged: `runs.js close` still refuses an unverified run without `AI_WORKFLOW_ADMIN=1`, no CLI flag bypasses it, and the dashboard supplies admin mode only for a confirmed keypress on a real terminal (without a TTY it prints one frame and exits).
- Fixed `runs.js close <unknown-id>` creating the run directory it was asked to close; it now fails with `unknown run <id>`.

## 1.7.0 — 2026-09-23

- Added a terminal dashboard for `/feature` runs: in-progress features on the left, the highlighted run's stages and specialist roles on the right, refreshing every second.
- `agentic progress` with no run id now opens the dashboard focused on the active feature instead of failing with "progress requires a run id". A run id, `--json`, `--markdown` or `--watch` keep the existing single-run output.
- Added `agentic dashboard [--all] [--run <id>]`, and `agentic ui` as an alias.
- Added `agentic runs [--all] [--json]`, listing every feature with progress, current stage, plan gate and which one is active.
- Added `agentic switch <run-id>` (alias `agentic use`) to make a feature the active run, so `agentic resume`, `approve` and `progress` default to it. In the dashboard, `enter` does the same for the highlighted feature.
- Dashboard keys: `↑↓`/`j k`/`tab` to move, `enter`/`space` to set active, `a` for finished runs, `r` to refresh, `home`/`end`, `q`/`esc`/`ctrl-c` to quit.
- The detail pane adapts to the terminal: it drops pending stages before the roles of a running stage, and terminals under 78 columns stack the panes instead of splitting them.
- Without a TTY the dashboard prints one frame and exits, so piping, redirection and CI capture keep working.
- Added `npm run workflow:dashboard` and `npm run workflow:runs`.

## 1.6.2 — 2026-09-22

- Fixed specialist routing for React Native apps. Because they depend on `react`, the subagent selector counted them as web frontends. Every React Native feature ran the web `frontend` analyst, and every `.ts`/`.tsx` change ran `frontend-review` alongside `react-native-review`. React Native repositories now route to web frontend specialists only when they also contain a web app directory (`frontend/`, `web/`, `apps/web/`), matching the workflow engine and the doctor.
- Added selector self-tests in both directions: React Native app → no frontend analyst or reviewer; React Native + `web/` → frontend analyst; React web app → frontend reviewer.

## 1.6.1 — 2026-09-22

- Fixed the optional `ios:xcode-select` warning not appearing under `agentic doctor`. The CLI injects `DEVELOPER_DIR` before the doctor runs, which hid the warning. Agentic now marks the injected value (`AGENTIC_XCODE_DISCOVERED=1`) so the doctor still reports that the system `xcode-select` needs fixing. A `DEVELOPER_DIR` you set yourself still suppresses the warning.
- The doctor now reads the system `xcode-select` path with `DEVELOPER_DIR` removed from the environment, because `xcode-select -p` returns `DEVELOPER_DIR` whenever it is set.

## 1.6.0 — 2026-09-22

- Fixed `agentic doctor` reporting `ios:simulator` as missing (and `ios:xcodebuild` as available when it could not run) when a full Xcode is installed but `xcode-select` points at the Command Line Tools. The doctor now finds Xcode in `/Applications`, `~/Applications`, `~/Desktop`, `~/Downloads`, or anywhere Spotlight finds it, runs `xcodebuild`/`simctl` through it, and shows an optional `ios:xcode-select` warning with the exact `sudo xcode-select -s …` fix.
- `agentic` now exports `DEVELOPER_DIR` for its own runs when Xcode is installed but not selected, so workflow agents and Appium can use Xcode. An explicit `DEVELOPER_DIR` is never overridden.
- Fixed `appium:node` checking the Node that runs the doctor instead of the Node that will run `appium-mcp`. The check now reads the configured MCP entry, reports the Node that entry will actually use, and names any installed Node 22+ that is not being used.
- Added `agentic mcp appium`, an MCP entry point that runs `appium-mcp` on an installed Node 22+ (`AGENTIC_APPIUM_NODE`, the `PATH` node, then the newest version from nvm, fnm, Volta, asdf, n or Homebrew) without changing the default Node.
- `agentic init` writes the launcher for new mobile projects and migrates existing standard `npx -y appium-mcp…` entries, keeping their `env`, `timeout`, pinned version and extra arguments. Custom commands are left unchanged.
- The Appium launcher forces `npm_config_legacy_peer_deps=false`. With `legacy-peer-deps=true` in a React Native project's `.npmrc`, npx installed the Appium drivers without their `appium` peer, and the server crashed at startup with `ERR_MODULE_NOT_FOUND`.
- Fixed the doctor treating every React Native app as a web frontend (it reported `frontend:build-script` as missing). As in the workflow engine, a React Native repository counts as a frontend only when it also contains a web app directory.
- Doctor iOS messages now include the underlying `xcrun`/`xcodebuild` error, and the simulator listing gets a longer timeout for the first CoreSimulator start.
- Fixed the `agentic update` Git-root check and its self-test on macOS by comparing canonical physical paths (`/var` vs `/private/var`).

## 1.5.3 — 2026-09-20

- Fixed the external-project runtime self-test on macOS by comparing canonical physical paths instead of raw `/var` vs `/private/var` path strings.
- Replaced the fragile worktree-path prefix assertion with a canonical containment check.
- Added explicit symlinked-project coverage so external-project isolation is validated through aliased repository paths on macOS/Linux/Windows.

## 1.5.2 — 2026-09-20

- Fixed standalone CLI project-root checks on macOS when temporary or symlinked paths resolve differently (for example `/var/...` vs `/private/var/...`).
- Added canonical real-path handling for CLI project resolution and a symlink-path regression self-test.
- Changed `agentic update` so stable updates are driven by an increased runtime SemVer, not by unrelated newer commits on `main`.
- Added updater regression coverage proving same-version documentation commits do not trigger reinstall/self-test.
- Added `sourceDiffers` to JSON update status so tooling can distinguish a newer source commit from an actual runtime-version update.

## 1.5.1 — 2026-09-20

- Fixed the Git executable bit for `ai/cli/agentic.js` so clone + `npm link` installations can execute the global `agentic` command on macOS/Linux.
- Added CI enforcement with `test -x ai/cli/agentic.js` so future releases cannot regress the CLI entrypoint permission.

## 1.5.0 — 2026-09-20

- Added `agentic update` for clone + `npm link` installations.
- Added `agentic update --check` and JSON update-status output without modifying the runtime working tree.
- Updates fetch the validated `origin/main` runtime, require a clean runtime clone, refuse custom/contributor branches, and only fast-forward local `main`.
- The updater runs `npm ci`, refreshes the global `npm link`, validates runtime metadata, and executes standalone CLI/external-project self-tests before declaring success.
- Failed post-update installation or verification triggers rollback to the exact previous runtime commit and attempts to restore dependencies/linking.
- Runtime update logic operates only on the installed Agentic runtime clone; project repositories and `.agentic-runs/` are never modified by the updater.
- Added a local bare-Git updater regression test covering update discovery, dirty-clone refusal, and safe fast-forward application.

## 1.4.1 — 2026-09-20

- Fixed standalone doctor false negatives for Appium MCP when the server is configured globally or named `appium-mcp` instead of `appium`.
- Added shared MCP discovery across project config, runtime config, user-level Claude config, user-level Codex config, and Claude MCP listing.
- Distinguished a globally installed `appium-mcp` package from a configured MCP server and improved remediation text.
- Made `agentic init` idempotently merge the standard Appium MCP entry into mobile projects while preserving existing MCP servers.
- Normalized `appium`, `appium-mcp`, and `mcp-appium` to one logical capability for doctor and subagent preflight.
- Enforced the Appium MCP Node 22+ prerequisite when mobile verification is required.

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

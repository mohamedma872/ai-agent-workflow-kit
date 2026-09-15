# AI task: `feature` — the agentic delivery workflow (`/feature`)

| | |
|---|---|
| **What it does** | Delivers a feature or ticket end-to-end: requirements → acceptance criteria → definition of done → repo inspection → parallel specialist analyses → plan for approval → implementation → build and tests → independent reviews → fixes → verification. Every step leaves an artifact in `ai/runs/<id>/`. |
| **Entry point** | `/feature <request or PROJ-123> [plan-only]` (skill `.claude/skills/feature/SKILL.md`), headless: `claude -p "/feature …"` |
| **Specialists** | `.claude/agents/`: mobile-architect · android-expert · ios-expert · security-reviewer · qa-engineer · performance-reviewer · code-reviewer — all read-only |
| **Provider** | Claude Code only (subagents are a Claude Code mechanism); the fence and the grader are the shared ones |
| **Artifacts a run leaves** | `ai/runs/<id>/00-request.md … 11-verification.md`, `05-analysis/*.md`, `09-reviews/*.md`, `plan.approved`, `state.json`; plus the diff |
| **Irreversible actions** | commits (normal runs only, after approval), Jira writes (ask), the device pass via `/device-qc` (separate run) |
| **Owner** | Mohamed |

## Guardrails

Generic fence: `ai/guard.yaml`. This task adds:

| Rule | Where | Effect |
|---|---|---|
| Plan gate | `guard.js` | While a run is active and `plan.approved` is missing: every edit outside `ai/runs/` and every `git commit` is **denied**. The orchestrator cannot implement early. |
| Approval is the human's act | `guard.js` | Writing `plan.approved` (or `runs.js approve`) **asks** the user; allowing it is the approval. In eval mode the gate opens once `06-plan.md` exists. |
| Evidence | `guard.yaml` | `ai/runs/` is never deleted by an agent. |
| Closing a run | `guard.yaml` | `runs.js close` asks — it lifts the gate. |
| Subagents | inherited | Every subagent tool call passes through the same fence; they get the AC text, never credentials. |

Known limitation: the gate keys on the `Write`/`Edit`/`apply_patch` tools and
`git commit`; a shell `sed -i` on a product file is not caught by this rule
(the generic self-protection covers only guarded files).

## Evals

`cases.yaml` — `plan-only-biometric` (the workflow must stop at the plan with
all pre-implementation artifacts and change nothing) and `feature-version-row`
(a small real change end-to-end: artifacts, allowed files, testID, both
languages, eslint and JSON verify). `adapter.js` runs `claude -p "/feature …"`
with `FEATURE_RUN_ID`, copies the run folder into the trial dir as
`artifacts/`, captures the diff, restores the tree, closes the run.

```bash
node ai/evals/run.js feature list
node ai/evals/grade.js feature plan-only-biometric --oracle --no-write
node ai/evals/run.js feature run --case plan-only-biometric --agent claude --dry-run
node ai/evals/run.js feature run --case plan-only-biometric --agent claude       # ~$3–6, ~10 min, plain terminal
node ai/evals/run.js feature summary
```

Baseline: not run yet (2026-09-15).

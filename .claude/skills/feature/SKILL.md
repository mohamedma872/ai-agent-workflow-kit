---
name: feature
description: Deliver a feature or ticket end-to-end with the provider-independent agentic workflow — requirements → acceptance criteria → definition of done → repo inspection → specialist analysis → approved plan → implementation → tests → independent reviews → fixes → verification. The workflow is defined in ai/workflows/feature.yaml; Claude Code is the orchestrator, while roles can execute through Claude, Codex, or future executors from ai/agents.yaml. Usage — /feature <request or PROJ-123> [plan-only]
---

You are the workflow orchestrator, not the implementation provider.

The source of truth for the agentic DAG and role routing is
`ai/workflows/feature.yaml`. Executors live in `ai/agents.yaml`. Use
`ai/workflow/router.js` to resolve or execute a role. Claude Code may optimize
roles mapped to Claude by using the matching `.claude/agents/` subagent; roles
mapped to another executor must go through the router.

Every phase leaves evidence in `ai/runs/<id>/`. The run can resume, humans can
inspect it, and evals can grade it. `$ARGUMENTS` is the feature request or Jira
key, optionally followed by `plan-only`.

## 0 — Validate the workflow and start/resume

Run these first:

```bash
node ai/workflow/router.js check
node ai/workflow/router.js show feature
node ai/tasks/feature/runs.js start <id>
```

Run id: Jira key when present, otherwise a kebab-case slug. In eval mode,
`FEATURE_RUN_ID` wins. Resume at the first unresolved phase in `state.json`.
Record every transition with:

```bash
node ai/tasks/feature/runs.js set <phase> <pending|in_progress|pass|fail|blocked|skipped> [note]
```

Phases: `request`, `requirements`, `acceptance-criteria`, `definition-of-done`,
`inspection`, `analysis`, `plan`, `approval`, `implementation`, `build-test`,
`reviews`, `fixes`, `verification`.

## The execution model

The workflow owns the process; the provider does not.

```text
USER
  |
  v
ORCHESTRATOR (Claude today; replaceable later)
  |
  +--> workflow DAG: ai/workflows/feature.yaml
  |
  +--> role router: ai/workflow/router.js
           |
           +--> Claude executor
           +--> Codex executor
           +--> future executor from ai/agents.yaml
  |
  v
SHARED GUARDRAILS: ai/guard.yaml + task guards
  |
  v
FILES / SHELL / MCP / GIT
```

Before assigning a concrete role, resolve it:

```bash
node ai/workflow/router.js resolve feature <role> --json
```

If the resolved executor is `claude` and the role declares a
`claude_subagent`, use that subagent. Otherwise create a context file inside the
run folder and execute the role through:

```bash
node ai/workflow/router.js exec feature <role> \
  --prompt-file ai/runs/<id>/<role>-context.md \
  --output-file ai/runs/<id>/<role>-agent.md
```

Do not silently substitute a provider. The router owns fallback selection.

## The plan gate

While the run is active and `ai/runs/<id>/plan.approved` does not exist, the
feature guard denies product-file edits and commits. Workflow state markers
cannot be forged through shell commands. Approval is a human act through the
normal approval write or:

```bash
node ai/tasks/feature/runs.js approve <id>
```

Never ask an implementation/fix executor to run before this gate is open.

## 1 — Request → `00-request.md`

Capture the request verbatim. If it contains a Jira key, read the ticket and
record summary, description, acceptance criteria and relevant links. Reads are
allowed; external writes are not part of this phase.

## 2 — Requirements → `01-requirements.md`

Write the user story, in-scope work, out-of-scope work, assumptions and open
questions. Resolve ambiguities from the repository/ticket where possible rather
than inventing requirements.

## 3 — Acceptance criteria → `02-acceptance-criteria.md`

Number them `AC-1..n`. Every AC must be testable and include a negative case
when appropriate. For user-facing mobile/UI behavior, include EN + AR and RTL
requirements where relevant.

## 4 — Definition of Done → `03-definition-of-done.md`

Number `D-1..n`. Cover relevant lint/type/build/test commands, both platforms
when applicable, translations, accessibility/testIDs, security/code/performance
reviews, documentation, and eval coverage when the feature itself adds an
LLM/agent capability.

## 5 — Inspect the repository → `04-inspection.md`

Inspect navigation, screens, modules, services, APIs, translations, tests,
native folders and existing patterns. Record reusable pieces and concrete
`file:line` evidence. Decide which selective analysis roles are relevant.

## 6 — Specialist analysis (parallel when independent)

The workflow defines these possible roles:

- `architect` — always.
- `qa-plan` — always.
- `security` — auth/session/storage/PII/payments/deep links/WebView/permissions/native dependencies/external effects.
- `android` / `ios` — when the platform or native layer is affected.
- `performance` — rendering-heavy UI, startup, networking/caching, memory/concurrency.
- `backend` — server/API/database/queue/migration work.
- `frontend` — web UI/routing/forms/a11y/browser behavior.

Give every selected role the request, acceptance criteria, relevant inspection
findings and its required artifact path. Run independent roles in parallel.
Store their reports under `05-analysis/` using the artifact names declared in
`ai/workflows/feature.yaml`.

Specialists analyze; they do not implement.

## 7 — Synthesize the plan → `06-plan.md`

Do not concatenate reports. Resolve disagreements and trace decisions to their
source analysis.

Required structure:

```text
# Plan — <request>
## Summary
## Change list
| # | file | change | new/edit | source analysis |
## Test plan
| test | AC | level | expected result |
## Risks and mitigations
## Out of scope
## Executor routing
| stage/role | selected executor | fallback |
## Estimated effort / cost constraints
```

Use `router.js resolve` for the executor-routing table so the plan describes the
actual execution path.

Then STOP and ask the user: `Approve` or `Request changes`. Revise and ask again
when changes are requested. On approval, open the plan gate. For `plan-only`,
mark approval skipped, close the run and stop without product edits.

## 8 — Implementation through the routed executor

Resolve `implementation`. By default the workflow routes it to Codex with
Claude as fallback.

Create `ai/runs/<id>/implementation-context.md` containing:

- the approved `06-plan.md` in full,
- `02-acceptance-criteria.md`,
- relevant DoD items,
- exact allowed scope/files where known,
- repository patterns found during inspection,
- explicit instruction not to commit/push/deploy or modify workflow/guard files.

Execute:

```bash
node ai/workflow/router.js exec feature implementation \
  --prompt-file ai/runs/<id>/implementation-context.md \
  --output-file ai/runs/<id>/implementation-agent.md
```

Then independently inspect the resulting diff. Write `07-implementation.md`
with files changed, what was implemented, tests added, and any deviation from
the approved plan. A provider's final message is evidence, not proof.

## 9 — Build/test

Resolve `qa-execute`. If Claude is selected, the configured `qa-engineer`
subagent may execute the checks; otherwise route it externally with a context
file. Record exact commands, exit statuses and relevant output in
`08-build-test.md`. Never change product behavior merely to turn a red test
green without tracing it to the approved plan.

Typical project commands may include lint, type checking, targeted unit tests,
integration tests and platform builds. Use the repository's real commands, not
hard-coded examples when they differ.

## 10 — Independent reviews

Run `code-review` and `security-review` independently; run
`performance-review` when relevant. Resolve each role first. Parallelize
independent reviews. Save their reports under `09-reviews/`.

Review agents are read-only and must review the actual diff, ACs and plan.
Implementation-agent self-review does not replace an independent review.

## 11 — Fix validated findings through the routed executor

Create `10-fixes.md` with every finding marked `valid` or `rejected` and the
reason. Resolve the `fixes` role; by default it routes to Codex with Claude
fallback. Put only validated findings plus the approved scope into
`fixes-context.md`, then execute:

```bash
node ai/workflow/router.js exec feature fixes \
  --prompt-file ai/runs/<id>/fixes-context.md \
  --output-file ai/runs/<id>/fixes-agent.md
```

Re-run affected tests and request another independent review only for blockers
or materially changed risk areas.

## 12 — Verification → `11-verification.md`

For every `AC-n` and `D-n`, record `PASS`, `FAIL`, or `pending-device` plus
objective evidence: file/line, test name, command result or review finding.
Never mark an item passed only because an executor said it passed.

Then:

```bash
node ai/tasks/feature/runs.js set verification pass
node ai/tasks/feature/runs.js close
```

Final response format:

```text
Feature: <request> · run ai/runs/<id>/
AC: <n>/<n> PASS · DoD: <n>/<n> PASS (<pending-device items>)
Routing: architect <agent> · implementation <agent> · QA <agent> · fixes <agent>
Reviews: security <verdict> · code <verdict> · performance <verdict>
Changed: <files>
Tests: <commands/results>
Commit: <sha or "not committed">
```

## Eval mode

`AI_EVAL=1` is set by the eval harness, never manually. There is no human to
approve. Use `FEATURE_RUN_ID`; complete `06-plan.md`, let the eval-mode gate
open according to the task guard, never commit/push/write externally, skip
physical-device checks, and still produce all artifacts. The grader evaluates
end state and artifacts rather than trusting agent messages.

## Invariants

- Workflow definition is provider-independent; provider commands belong only in `ai/agents.yaml`.
- Every executor runs under the same repository guardrails.
- No implementation before approval.
- No executor may modify `ai/guard*`, `ai/workflow*`, `ai/workflows*`, task guards, agent wiring, or approval state to make itself pass.
- Read-only roles do not edit product files.
- Parallelize only independent work; dependencies in `ai/workflows/feature.yaml` are authoritative.
- Artifacts are evidence; end-state verification decides whether the feature is done.

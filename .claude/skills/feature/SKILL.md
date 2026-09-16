---
name: feature
description: Deliver a feature or ticket end-to-end with the provider-independent agentic workflow — requirements → acceptance criteria → definition of done → repo inspection → specialist analysis → approved plan → implementation → tests → independent reviews → fixes → verification. Claude orchestrates; roles can execute through Claude, Codex, or future executors. Codex roles should be delegated through the local codex-delegate MCP server so detailed context/results stay in run artifacts instead of inflating Claude context. Usage — /feature <request or PROJ-123> [plan-only]
---

You are the workflow orchestrator, not the implementation provider.

The source of truth for stages and routing is `ai/workflows/feature.yaml`.
Executor launch commands live in `ai/agents.yaml`. Validate and inspect the
workflow through `ai/workflow/router.js`. Every phase leaves evidence in
`ai/runs/<id>/` so the run can resume, humans can inspect it, and evals can
grade the end state.

## 0 — Validate and start/resume

```bash
node ai/workflow/router.js check
node ai/workflow/router.js show feature
node ai/tasks/feature/runs.js start <id>
```

Run id: Jira key when present, otherwise a kebab-case slug. In eval mode,
`FEATURE_RUN_ID` wins. Resume at the first unresolved phase in `state.json`.
Record transitions with:

```bash
node ai/tasks/feature/runs.js set <phase> <pending|in_progress|pass|fail|blocked|skipped> [note]
```

Phases: `request`, `requirements`, `acceptance-criteria`, `definition-of-done`,
`inspection`, `analysis`, `plan`, `approval`, `implementation`, `build-test`,
`reviews`, `fixes`, `verification`.

For parallel groups, register all selected roles before delegation:

```bash
node ai/tasks/feature/runs.js select-roles analysis <role...>
node ai/tasks/feature/runs.js select-roles reviews <role...>
```

Then update each role with `set-role`. The parent `analysis`/`reviews` status is
derived automatically from the selected role states; do not leave a stale
parent `in_progress` after all children have finished.

## Execution model

```text
USER
  |
  v
CLAUDE ORCHESTRATOR
  |
  +--> workflow DAG: ai/workflows/feature.yaml
  |
  +--> role router: ai/workflow/router.js
           |
           +--> Claude subagent (analysis/review/QA roles)
           |
           +--> Codex through MCP (implementation/fix roles)
           |
           +--> feature-runner (executable conditional verification roles)
           |
           +--> future executor from ai/agents.yaml
  |
  v
SHARED GUARDRAILS: ai/guard.yaml + task guards
  |
  v
FILES / SHELL / MCP / GIT
```

Resolve every concrete role before running it:

```bash
node ai/workflow/router.js resolve feature <role> --json
```

If the selected executor is `claude` and the role declares a
`claude_subagent`, use that subagent. If the selected executor is `codex`,
prefer MCP delegation as described below. Do not silently substitute a provider;
the workflow/router owns provider selection and fallback.

## Token-efficient Claude → Codex delegation through MCP

The project MCP config can expose:

```text
mcp__codex-delegate__delegate
```

Use it for Codex-routed roles. Do not put the full plan, ACs, diff or review
text in the MCP arguments. First write a focused context artifact under the
active run, then pass only paths and small control fields to the MCP tool.

Example for implementation:

```text
prompt_file  = ai/runs/<id>/implementation-context.md
output_file  = ai/runs/<id>/implementation-agent.md
workflow     = feature
role         = implementation
```

The MCP server reads the context file locally, invokes Codex through the
provider-independent router, writes Codex's detailed final response to the
output artifact, and returns only compact metadata such as status, changed file
names and the artifact path.

If the MCP server is unavailable, fall back to the equivalent CLI call:

```bash
node ai/workflow/router.js exec feature <role> \
  --agent codex \
  --prompt-file ai/runs/<id>/<role>-context.md \
  --output-file ai/runs/<id>/<role>-agent.md
```

The fallback should be exceptional; MCP is the preferred Claude→Codex transport.

## Plan gate

While the run is active and `ai/runs/<id>/plan.approved` does not exist, the
feature guard denies product-file edits and commits. Direct shell mutation of
`plan.approved` or `ai/runs/_active` is denied. Approval is a human act through
the normal workflow or:

```bash
node ai/tasks/feature/runs.js approve <id>
```

Approval automatically records both `plan = pass` and `approval = pass`.
Never delegate implementation or fixes before the plan gate is open.

## 1 — Request → `00-request.md`

Capture the request verbatim. If it contains a Jira key, read the ticket and
record summary, description, acceptance criteria and relevant links. Reads are
allowed; external writes are not part of this phase.

## 2 — Requirements → `01-requirements.md`

Write the user story, in-scope work, out-of-scope work, assumptions and open
questions. Resolve ambiguities from repository/ticket evidence where possible;
do not invent requirements.

## 3 — Acceptance criteria → `02-acceptance-criteria.md`

Number `AC-1..n`. Every AC must be testable and include a negative case when
appropriate. For user-facing mobile/UI behavior, include EN + AR and RTL
requirements where relevant.

## 4 — Definition of Done → `03-definition-of-done.md`

Number `D-1..n`. Cover relevant lint/type/build/test commands, both platforms
when applicable, translations, accessibility/test IDs or semantics,
security/code/performance reviews, documentation, and eval coverage when the
feature adds an LLM/agent capability.

For mobile/UI features, include final Appium screenshot evidence in the DoD.

## 5 — Inspect the repository → `04-inspection.md`

Inspect navigation, modules, services, APIs, translations, tests, native
folders and neighbouring patterns. Record reusable pieces and concrete
`file:line` evidence. Decide which selective analysis roles are relevant.

Detect the implementation stack from repository evidence rather than assuming
React Native. For Flutter, inspect `pubspec.yaml`, `pubspec.lock`, `lib/`,
`test/`, `integration_test/`, Flutter plugins/platform channels and Android/iOS
integration where relevant.

Classify final mobile screenshot evidence during inspection:

```bash
# Mobile or device-visible UI feature
node ai/tasks/feature/runs.js evidence required "mobile/UI feature"

# Genuinely non-mobile/non-UI work; a reason is mandatory
node ai/tasks/feature/runs.js evidence not-required "backend-only change"
```

Do not leave evidence `unclassified`. Final verification will reject `pass` for
normal runs until this classification is explicit.

## 6 — Specialist analysis

Possible roles are declared in `ai/workflows/feature.yaml`:

- `architect` — always; stack-aware across React Native, Flutter and native mobile.
- `qa-plan` — always.
- `security` — auth/session/storage/PII/payments/deep links/WebView/permissions/native dependencies/plugins/external effects.
- `android` / `ios` — when platform/native behavior is affected.
- `flutter` — when the repository is Flutter and the feature affects Dart/widget/state/navigation/plugin/platform-channel behavior.
- `performance` — rendering/rebuilds, startup, networking/caching, memory/concurrency.
- `backend` — server/API/database/queue/migration work.
- `frontend` — web UI/routing/forms/a11y/browser behavior.
- `docs` — when current/version-specific external docs matter.

For Flutter changes that also modify native platform configuration, select
`flutter` plus the relevant `android` and/or `ios` role. Flutter expertise does
not replace platform expertise for manifests, plist/entitlements, Gradle/Xcode,
permissions, or native plugin behavior.

Before launching specialists, register the exact selected set:

```bash
node ai/tasks/feature/runs.js set analysis in_progress
node ai/tasks/feature/runs.js select-roles analysis architect qa-plan flutter security
```

Use the actual selected roles, not the example list above. For each role:

```bash
node ai/tasks/feature/runs.js set-role analysis <role> in_progress <executor>
# delegate, collect artifact/evidence
node ai/tasks/feature/runs.js set-role analysis <role> pass <executor>
```

On failure/block/skip, record that exact status. `runs.js` automatically derives
the parent `analysis` status once selected roles change.

Give each selected role the request, ACs and relevant inspection evidence. Run
independent roles in parallel. For Claude-routed roles, use the declared
`.claude/agents/` subagent. Store reports under `05-analysis/` using artifact
names declared by the workflow.

Specialists analyze; they do not implement.

## 7 — Synthesize `06-plan.md`

Combine findings rather than concatenating reports. Resolve disagreements and
trace decisions to their analysis.

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

Use `router.js resolve` for the routing table. Then STOP and ask the user:
`Approve` or `Request changes`. Revise and ask again when changes are requested.
For `plan-only`, mark approval skipped, close the run and stop without product
edits.

## 8 — Implementation: delegate to routed executor

Resolve `implementation`; the default is Codex with Claude fallback.

Create `ai/runs/<id>/implementation-context.md`. Keep it focused but complete:

- approved `06-plan.md`;
- `02-acceptance-criteria.md`;
- relevant DoD items;
- known allowed scope/files;
- repository patterns from inspection;
- explicit instruction not to commit/push/deploy or modify guard/workflow state.

When Codex is selected, call `mcp__codex-delegate__delegate` with only:

```text
workflow=feature
role=implementation
prompt_file=ai/runs/<id>/implementation-context.md
output_file=ai/runs/<id>/implementation-agent.md
```

After Codex returns, inspect the actual diff yourself. Write
`07-implementation.md` with files changed, implementation evidence, tests added,
and any deviation from the approved plan. Codex's final message is evidence,
not proof.

## 9 — Build/test

Resolve `qa-execute`. If Claude is selected, use the configured `qa-engineer`
subagent. Record exact commands, exit statuses and useful output in
`08-build-test.md`. Use the repository's real lint/type/static-analysis/test/build
commands. For Flutter, detect the project's actual commands and configuration;
common examples include `flutter analyze`, `flutter test`, widget/integration
tests and platform builds, but do not invent scripts/flavors the repo does not
use.

Never change product behavior merely to make a red test green unless the change
is traced to the approved plan.

## 10 — Independent reviews

Resolve `code-review` and `security-review`; run `performance-review` when
relevant. The common reviewers are stack-aware; Flutter diffs must be reviewed
using Flutter/Dart conventions rather than React Native assumptions. Use
`flutter-expert` in review mode when Flutter-specific behavior needs a focused
platform/framework review.

Register the selected review set before delegation:

```bash
node ai/tasks/feature/runs.js set reviews in_progress
node ai/tasks/feature/runs.js select-roles reviews code-review security-review performance-review
```

Use only the reviewers actually selected. Update each with `set-role` before and
after delegation. The parent `reviews` status is derived automatically.

Parallelize independent reviews. Save reports under `09-reviews/`. Reviewers are
read-only and review the actual diff, ACs and plan. An implementation-agent
self-review does not replace independent review.

## 11 — Fix validated findings

Create `10-fixes.md`, marking every finding `valid` or `rejected` with reason.
Resolve `fixes`; the default is Codex with Claude fallback.

Create `ai/runs/<id>/fixes-context.md` containing only validated findings,
relevant diff evidence and approved scope. When Codex is selected, delegate via
MCP:

```text
workflow=feature
role=fixes
prompt_file=ai/runs/<id>/fixes-context.md
output_file=ai/runs/<id>/fixes-agent.md
```

Re-run affected tests. Re-request review only for blockers or materially changed
risk areas.

## 12 — Verification → `11-verification.md`

For every `AC-n` and `D-n`, record `PASS`, `FAIL`, or `pending-device` plus
objective evidence: file/line, test name, command result, review finding, or
device screenshot. Never mark an item passed only because an executor said it
passed.

### Executable Appium evidence gate

Do **not** manually perform or merely describe the `mobile-evidence` role here.
The workflow runner owns execution of the conditional role declared by the
verification stage in `ai/workflows/feature.yaml`.

After fixes and affected tests are complete, run:

```bash
node ai/workflow/feature-runner.js verification --run <id>
```

or for the active run:

```bash
npm run workflow:mobile-evidence
```

When mobile screenshot evidence is `required`, the runner automatically:

1. resolves and executes the routed `mobile-evidence` role through `router.js`;
2. instructs that role to use Appium MCP against the final post-fix build;
3. waits for the headless agent process to finish;
4. requires a fresh manifest at:
   `ai/runs/<id>/device/mobile-device-qc.md`;
5. requires one or more fresh PNG screenshots matching:
   `ai/runs/<id>/device/screenshots/*.png`;
6. requires the manifest `## Verdict` to be `PASS`;
7. records execution status, timestamps, manifest path, and screenshot paths in
   `state.json`.

The runner applies to native Android/iOS, React Native, and Flutter. Flutter and
React Native are tested through their built Android/iOS application. Android
uses the appropriate Appium Android session/driver; iOS uses the appropriate
Appium iOS session/driver.

If Appium MCP is not available to the headless Claude session, the build is not
runnable, no simulator/emulator/device is available, credentials/test data are
missing, the agent exits non-zero, the manifest is missing, the screenshots are
missing/stale, or the verdict is not PASS, the runner fails and records mobile
evidence as blocked. Do not continue to a passing verification in that case.

For genuinely non-mobile/non-UI work classified as `not-required`, the runner
returns successfully without launching Appium.

After the runner succeeds, write/update `11-verification.md` with the device
evidence paths and then mark verification:

```bash
node ai/tasks/feature/runs.js set verification pass
node ai/tasks/feature/runs.js close
```

`runs.js` independently enforces the required evidence files before accepting
`verification = pass`; the runner is what now **executes** the previously
passive `conditional_role` and produces fresh evidence.

Final response:

```text
Feature: <request> · run ai/runs/<id>/
AC: <n>/<n> PASS · DoD: <n>/<n> PASS (<pending-device items>)
Routing: architect <agent> · implementation <agent> · QA <agent> · fixes <agent>
Reviews: security <verdict> · code <verdict> · performance <verdict>
Device evidence: <required/not-required> · <screenshot count/path or reason>
Changed: <files>
Tests: <commands/results>
Commit: <sha or "not committed">
```

## Eval mode

`AI_EVAL=1` is set by the eval harness, never manually. There is no human to
approve. Use `FEATURE_RUN_ID`; complete `06-plan.md`, let the eval-mode gate
open according to the task guard, never commit/push/write externally, skip
physical-device checks, and still produce all normal non-device artifacts. The
verification evidence gate is bypassed only by the harness in `AI_EVAL=1`; the
grader evaluates end state and artifacts rather than trusting agent messages.

## Invariants

- Workflow definition is provider-independent; provider commands belong only in `ai/agents.yaml`.
- Every executor runs under the same repository guardrails.
- Claude→Codex delegation prefers MCP with artifact paths, not large inline prompts/results.
- No implementation before approval.
- No executor may modify `ai/guard*`, `ai/workflow*`, `ai/workflows*`, task guards, agent wiring, or workflow state to make itself pass.
- Read-only roles do not edit product files.
- Parallelize only independent work; dependencies in `ai/workflows/feature.yaml` are authoritative.
- Selected parallel roles must be registered so parent phases reconcile automatically.
- Flutter is a first-class mobile stack: select `flutter` for Flutter behavior and add Android/iOS roles when native integration changes.
- Required mobile/UI completion must execute `feature-runner.js verification` and produce fresh Appium evidence under the active run.
- Artifacts are evidence; end-state verification decides whether the feature is done.

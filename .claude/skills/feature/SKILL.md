---
name: feature
description: Deliver a feature or ticket end-to-end with the agentic workflow — requirements → acceptance criteria → definition of done → repo inspection → parallel specialist analysis (mobile-architect, android-expert, ios-expert, security-reviewer, qa-engineer, performance-reviewer) → plan for approval (an ENFORCED gate) → implementation → build and tests → independent security, code and performance reviews → fixes → AC/DoD verification. Every step leaves an artifact in ai/runs/<id>/. Usage — /feature <request or PROJ-123> [plan-only]
---

You are the orchestrator. Specialists analyse and review; you decide, plan,
implement, and verify. Every step writes its artifact to `ai/runs/<id>/` so
the user can read it, the run can resume, and the eval can grade it.
`$ARGUMENTS` = the request (free text or a Jira key like `PROJ-123`), optionally
followed by `plan-only` (stop after the plan; never edit product files).

## Step 0 — run folder + resume (always first)

1. Run id: the Jira key if present, else a kebab-case slug of the request; in
   eval mode the environment variable `FEATURE_RUN_ID` wins.
2. `node ai/tasks/feature/runs.js start <id>` — creates `ai/runs/<id>/`,
   `state.json`, and marks the run active. If the run already exists this
   prints its phase statuses: **resume at the first unresolved phase**, never
   redo a passed one. Record every phase transition with
   `node ai/tasks/feature/runs.js set <phase> <in_progress|pass|fail|blocked|skipped> [note]`.
3. Create the visible task list (TaskCreate), one task per phase below, and
   post a one-line status message at every transition.

Phases (state.json names): `request`, `requirements`, `acceptance-criteria`,
`definition-of-done`, `inspection`, `analysis`, `plan`, `approval`,
`implementation`, `build-test`, `reviews`, `fixes`, `verification`.

## The plan gate is enforced

While the run is active and `ai/runs/<id>/plan.approved` does not exist, the
fence (`ai/tasks/feature/guard.js`) **denies** every edit outside `ai/runs/`
and every `git commit`. You cannot implement early even by accident. Writing
`plan.approved` asks the user — allowing that write is the approval. The user
can also approve from a terminal: `node ai/tasks/feature/runs.js approve <id>`.

## Steps 1–8 — before implementation

1. **Read the requirements** → `00-request.md` (the request verbatim + the Jira
   ticket via `mcp__jira__jira_get_issue` when a key is given: summary,
   description, acceptance criteria, links) and `01-requirements.md` (your
   understanding: user story, scope, out of scope, assumptions, open questions).
2. **Acceptance criteria** → `02-acceptance-criteria.md`: numbered `AC-1..n`,
   each testable, each with the negative case where one exists; both languages
   (EN + AR) and RTL when UI is involved.
3. **Definition of Done** → `03-definition-of-done.md`: numbered `D-1..n` —
   lint clean, tsc no new errors, unit tests for new logic, both platforms
   considered, translations in EN + AR, testIDs, security review PASS, code
   review APPROVE, performance review PASS or accepted concerns, docs/ticket
   updated, and — if the feature adds an LLM/agent capability — an
   `ai/tasks/<name>/` folder per `ai/README.md`.
4. **Inspect the repository** yourself (navigation, screens, hooks, services,
   translations, native folders, tests) → `04-inspection.md`: what exists,
   what to reuse, `file:line`.
5. **Decide which subagents are needed** — record the decision and why in
   `04-inspection.md`:

   | subagent | run when |
   |---|---|
   | `mobile-architect` | always |
   | `qa-engineer` (mode `plan`) | always |
   | `security-reviewer` (mode `threat-model`) | auth, session, storage, biometrics, payments, PII, deep links, WebView, permissions, new native dependency |
   | `android-expert` | `android/` touched, native module, permissions, Play policy, platform behaviour |
   | `ios-expert` | `ios/` touched, native module, permissions, App Store policy, platform behaviour |
   | `performance-reviewer` (mode `analysis`) | lists, rendering-heavy UI, startup, network/caching changes |

6. **Run the analysis subagents in parallel** — one Agent call per subagent in
   the SAME message, `run_in_background: true`, then wait for all. Each prompt
   contains: the request, the full text of `02-acceptance-criteria.md`, the
   run folder path, the mode, and "return your report as your final message
   in the required structure". Save each report verbatim to
   `05-analysis/<subagent>.md`. Subagents are read-only; you write the files.
7. **Combine the findings** → the plan.
8. **Plan for approval** → `06-plan.md`:

   ```
   # Plan — <request>
   ## Summary (3 lines)
   ## Change list (ordered)  | # | file | change | new/edit | from which analysis |
   ## Test plan  (from qa-engineer, TC ↔ AC)
   ## Risks and mitigations  (from security / platform / performance analyses)
   ## Out of scope
   ## Estimated effort and cost
   ```
   Then **STOP** and ask with AskUserQuestion: `Approve` / `Request changes`.
   On changes: revise, ask again. On approve: write
   `ai/runs/<id>/plan.approved` (content: `approved: <ISO date>`) — the fence
   asks the user once more; that allow is the approval — and set `approval` to
   `pass`. If `$ARGUMENTS` ends with `plan-only`: set `approval` to `skipped
   plan-only`, close the run (Step 13c) and stop here.

## Steps 9–13 — after approval

9. **Implement the plan** exactly as listed; deviations go into
   `07-implementation.md` with the reason. Log every file touched. Follow the
   neighbouring patterns; translations in both languages; testIDs; no debug
   code. Add unit tests for new logic (`git add -f` for `__tests__/`).
10. **Build and test** — delegate to `qa-engineer` (mode `execute`) or run
    yourself: `yarn lint`, `npx tsc --noEmit --skipLibCheck` (separate new
    errors from the repo's pre-existing ones), `yarn jest <pattern>`, and any
    DoD command → `08-build-test.md` with the exact commands and results. A
    device pass is `/device-qc <id>` (separate run, Claude Code only) — note it
    as pending when not run.
11. **Independent reviews in parallel** — `security-reviewer` (mode
    `diff-review`), `code-reviewer`, and `performance-reviewer` (mode
    `diff-review`) when performance-relevant; `android-expert` / `ios-expert`
    in review mode when their platform was touched. Same-message Agent calls,
    background, wait for all. Save to `09-reviews/<subagent>.md` verbatim.
12. **Fix valid findings** → `10-fixes.md`: a table of every finding with
    `valid | rejected` and the reason; fix the valid ones; re-run step 10 for
    the touched suites; re-request a review only for blockers.
13. **Verify** → `11-verification.md`: every `AC-n` and `D-n` with `✓ / ✗ /
    pending-device` and the evidence (file:line, test name, review verdict).
    Then:
    a. `node ai/tasks/feature/runs.js set verification pass`
    b. Final message: the checklist below.
    c. `node ai/tasks/feature/runs.js close` — the run stops being active and
       the plan gate lifts for normal work.

```
Feature: <request> · run ai/runs/<id>/
AC: <n>/<n> ✓ · DoD: <n>/<n> ✓ (<pending-device items>)
Analyses: <subagents> · Reviews: security <verdict> · code <verdict> · perf <verdict>
Changed: <files> · Tests: <commands green> · Commit: <sha or "not committed">
```

## Eval mode (`AI_EVAL=1`, set by `ai/evals/run.js`, never by hand)

Nobody is there to answer. Use `FEATURE_RUN_ID` as the run id; do not call
AskUserQuestion — write `plan.approved` yourself after `06-plan.md` is complete
(the fence allows this only in eval mode); never commit or push (denied
anyway); skip the device pass; still produce every artifact — the grader reads
`ai/runs/<id>/` and the diff.

## Rules that never bend

- Never touch product files before `plan.approved` exists (the fence denies it; do not try to work around it).
- Never weaken the fence or the subagent definitions to pass a review.
- Subagents get the AC text in their prompt; they do not get credentials, and the fence denies them the same files it denies you.
- Combine, do not concatenate: the plan is your synthesis, with each decision traced to an analysis.
- When a specialist and you disagree, say so in the plan and let the user decide.

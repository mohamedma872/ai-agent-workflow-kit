# Runtime hardening evals

The runtime uses two complementary eval layers.

## 1. Agent behavior cases

`ai/tasks/feature/cases.yaml` contains end-state cases that are given to the feature workflow. They cover normal React Native, Android, iOS, Flutter, backend, and frontend work plus adversarial/failure-path requests such as:

- skipping the plan/human gate through shell writes;
- weakening the guard control plane;
- forging workflow state to jump DAG dependencies;
- fabricating Appium screenshots/session metadata;
- Appium/device unavailability;
- partial Android+iOS evidence;
- stale/copied evidence;
- timeout/retry/fallback/resume behavior;
- concurrent run/worktree isolation.

The feature adapter grades changed files, run artifacts, verification commands, and required evidence. Agent prose is not treated as proof of success.

## 2. Deterministic runtime regressions

`ai/evals/runtime-hardening-check.js` runs the runtime's objective self-tests for the security/state mechanisms behind those agent cases:

- controlled DAG/state transitions;
- deterministic engine behavior;
- retry/timeout/fallback/resume policy;
- attempt history;
- parallel worktree isolation;
- Appium session/build/stale-evidence attestation;
- mobile evidence runner contract;
- shell-write plan-gate protection;
- commit-bound GitHub verification summaries.

These checks run through `npm run exam:check` and before `npm run exam:nightly`.

## CI versus live evals

CI runs zero-cost oracle/null checks for every case and the deterministic runtime regressions. Live agent trials remain cost-controlled and can be scheduled with the existing exam scheduler. Include the `feature` task in scheduled live runs when you want the agent behavior cases exercised, for example:

```bash
npm run exam:nightly -- --tasks coding,feature --cap 25
```

A regression is therefore detectable in two ways: deterministic control-plane tests fail immediately in CI, while model behavior regressions are recorded by the live eval ledger/reports.

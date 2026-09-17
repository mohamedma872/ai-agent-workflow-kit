# AI task: `feature` — the agentic delivery workflow (`/feature`)

| | |
|---|---|
| **What it does** | Delivers a feature or ticket end-to-end: requirements → acceptance criteria → definition of done → repo inspection → parallel specialist analyses → plan for approval → implementation → build and tests → independent reviews → fixes → mobile evidence when required → verification. Every step leaves an artifact in `ai/runs/<id>/`. |
| **Entry point** | `/feature <request or PROJ-123> [plan-only]` (skill `.claude/skills/feature/SKILL.md`), headless: `claude -p "/feature …"` |
| **Specialists** | `.claude/agents/`: mobile-architect · android-expert · ios-expert · flutter-expert · security-reviewer · qa-engineer · performance-reviewer · code-reviewer · backend-expert · frontend-expert — read-only specialists |
| **Provider** | Claude orchestrates specialist roles; implementation/fixes route through the provider-independent workflow (Codex by default) |
| **Artifacts a run leaves** | `ai/runs/<id>/00-request.md … 11-verification.md`, `05-analysis/*.md`, `09-reviews/*.md`, `device/mobile-device-qc.md`, `device/screenshots/*` when mobile/UI evidence is required, `plan.approved`, `state.json`; plus the diff |
| **Mobile stacks** | Native Android/iOS, React Native, and Flutter. Flutter uses `flutter-expert`; native Android/iOS changes can additionally select the platform specialists. |
| **Irreversible actions** | commits (normal runs only, after approval), Jira writes (ask), external deployment/publishing (ask/deny according to guardrails) |
| **Owner** | Mohamed |

## Guardrails

Generic fence: `ai/guard.yaml`. This task adds:

| Rule | Where | Effect |
|---|---|---|
| Plan gate | `guard.js` | While a run is active and `plan.approved` is missing: every edit outside `ai/runs/` and every `git commit` is **denied**. The orchestrator cannot implement early. |
| Approval is the human's act | `guard.js` | Writing `plan.approved` (or `runs.js approve`) **asks** the user; allowing it is the approval. In eval mode the gate opens once `06-plan.md` exists. |
| Evidence | `guard.yaml` | `ai/runs/` is never deleted by an agent. |
| Final mobile evidence | `mobile-evidence.js` + `runs.js` + mobile-device-qc skill | Mobile/UI features execute the routed Appium evidence role before verification. The runner requires fresh `device/mobile-device-qc.md` and `device/screenshots/*.png`; `runs.js` still refuses verification pass when required evidence is missing. |
| Closing a run | `guard.yaml` | `runs.js close` asks — it lifts the gate. |
| Subagents | inherited | Every subagent tool call passes through the same fence; they get the AC text, never credentials. |

Known limitation: the gate keys on the `Write`/`Edit`/`apply_patch` tools and
`git commit`; a shell `sed -i` on a product file is not caught by this rule
(the generic self-protection covers only guarded files).

## Automatic mobile evidence

After implementation, tests, reviews and fixes are complete, run:

```bash
npm run workflow:mobile-evidence
```

The runner:

1. reads the active feature run and its mobile evidence classification;
2. derives Android/iOS targets from explicit evidence settings, selected platform specialists, or repository platform folders;
3. records a fresh attempt in `state.json`;
4. writes `device/mobile-evidence-context.md` from the run's AC/DoD/build/fix artifacts;
5. executes `router.js exec feature mobile-evidence`, which invokes Claude and requires the configured Appium MCP;
6. accepts only evidence created after the attempt started;
7. fails if any required target platform is missing fresh evidence.

Required outputs are exactly:

```text
ai/runs/<id>/device/mobile-device-qc.md
ai/runs/<id>/device/screenshots/*.png
```

Platform screenshot names use `android-` or `ios-` prefixes. If Appium/device/build access is unavailable, the runner returns non-zero and final verification stays blocked.

For an explicit platform set:

```bash
node ai/tasks/feature/mobile-evidence.js run <id> --platforms android,ios
```

For a configuration-only check without invoking the agent/Appium:

```bash
npm run workflow:mobile-evidence:dry-run
```

## Flutter routing

When repository inspection identifies a Flutter application (`pubspec.yaml` plus Flutter/Dart app sources), select the `flutter` analysis role for Flutter behavior. Select `android` and/or `ios` as well when the feature changes native platform configuration, permissions, manifests/plists, channels/plugins, Gradle/Xcode integration, or store-specific behavior.

For build/test, use the repository's actual Flutter tooling. Typical checks may include `flutter analyze`, `flutter test`, widget/integration tests, and platform builds, but the workflow must detect rather than assume the project's scripts and flavors.

For final mobile/UI evidence, Appium runs the finished Flutter app as an Android or iOS application and stores screenshot evidence under `ai/runs/<id>/device/screenshots/`.

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
node ai/evals/run.js feature run --case plan-only-biometric --agent claude
node ai/evals/run.js feature summary
```

Baseline: not run yet (2026-09-15).

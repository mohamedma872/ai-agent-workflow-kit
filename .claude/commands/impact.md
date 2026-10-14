---
description: Technical impact analysis of a branch against its merge base and the production branch — deterministic baseline, specialist fan-out, cross-cutting sweeps, adversarial verification, verified register (Markdown, CSV for Excel, JSON). Read-only on product code. Usage — /impact <run-id> --head <branch> [--base <ref>] [--prod <ref>] [--journeys "checkout, payments, login"] [--depth quick|standard|deep]
---

Run a technical impact analysis. Product code is never edited; everything is written under the run's `impact/` folder.

## 0. Arguments and defaults

From `$ARGUMENTS`: `run-id` (required), `--head` (required), `--base` (default: the production branch), `--prod` (default `origin/main`, else `origin/master`), `--journeys` (default: infer the revenue and session journeys from the code: login/session, catalogue/search, product page, cart, checkout, each payment method, order confirmation, orders/returns, account, membership/loyalty), `--depth`:

| depth | specialists | sweeps | verification |
|---|---|---|---|
| quick | layer specialists only | production-drift | 1 verifier per high finding |
| standard (default) | layer specialists + one `impact-analyst` per journey | all six | 3 lenses for high, 1 for medium/low |
| deep | standard + one `impact-analyst` per remaining feature group + completeness critic and gap round | all six | 3 lenses for high, 1 for medium/low, re-verify gap findings |

Tell the user the depth and a rough agent count before starting. Deep runs on a large branch use hundreds of agents; ask before a deep run.

## 1. Baseline (deterministic)

```bash
agentic impact <run-id> --base <base> --head <head> --prod <prod>
```

This writes `impact/baseline.md`, `baseline.json`, `namestatus.txt` and read-only worktrees `impact/worktrees/{base,head}`. Read `baseline.md` and use it as shared ground truth in every prompt. It already lists production commits whose files moved at head; those are fixes at risk of being lost at merge.

## 2. Discovery — one Agent call per item, all in the SAME message, `run_in_background: true`

Every prompt includes: both worktree paths, the main repo path and production ref, the path to `baseline.md`, the scope, the list of already-known findings (from an earlier review the user names, if any), and "return only the JSON your instructions define".

**Layer specialists** (existing kit agents, read-only):
- `mobile-architect`: layering, cross-feature coupling matrix, import cycles, DI graph, state-management migration completeness per feature (count wrapper patterns separately from real migrations), navigation coverage, fan-in hotspots, duplicate classes.
- `api-contract-reviewer`: endpoint inventory base vs head (save a CSV in `impact/scratch/`), dual network stacks, interceptors, timeouts, auth and 401 handling, error model, serialization changes.
- `performance-reviewer`: startup path, rebuild risk, lists/images, lifecycle leaks, binary size drivers, network duplication — each with the device measurement command.
- `qa-engineer`: coverage vs churn per feature, what existing tests really assert and whether they run on a fresh clone, journey risk matrix, first tests to write.
- `flutter-reviewer` / `android-reviewer` / `ios-reviewer` (whichever stacks `baseline.md` lists) + `dependency-migration-agent`: every changed non-source file, lock-file diff, code generation and CI cost, platform channels, localization migration, lint impact.

Ask the layer specialists to return their normal report **plus** a JSON block in the `impact-analyst` output shape for each regression they find, so verification can take them.

**Behavior** — `impact-analyst`, one per journey (and per feature group at `deep`), scope = that journey.

**Sweeps** — `impact-analyst`, one per sweep: `nullable-defaults`, `lost-fixes`, `production-drift`, `contracts`, `string-keyed-contracts`, `storage-migration`.

**Write each result to disk as soon as it arrives** — `impact/findings/<group>.json` (the analyst JSON) and `impact/layers/<agent>.md` (layer reports). Never hold results only in the conversation: if a usage limit stops the run, a resume skips every group whose file exists.

## 3. Verification — `impact-verifier`

For each finding, assign an id if missing (`<group>#<n>`) and launch verifiers:
- high or critical: three agents, lenses `code`, `provenance`, `impact`;
- medium and low: one agent, lens `all`.

Batch launches (one message per batch of independent calls). Write each verdict to `impact/verdicts/<findingId>.<lens>.json` on arrival; on resume, skip verdicts that exist. Spot-check two or three high findings yourself by reading the cited lines.

## 4. Critic and gap round (`deep` only)

One `impact-analyst` acting as completeness critic: given every group's `scopeCovered`/`notCovered` and the kept findings, name up to six concrete unreviewed scopes with heavy churn and user impact. Run one `impact-analyst` per gap, then verify as in step 3.

## 5. Synthesis and register

Write `impact/synthesis.json`:

```json
{ "releaseDecision": "one line", "headline": "two sentences",
  "fixBatches": [{"name": "...", "items": ["F-ids"], "whyFirst": "..."}],
  "rootCauses": [{"cause": "...", "findings": ["ids"], "systemicFix": "..."}],
  "mustTestOnDevice": ["..."] }
```

Then:

```bash
agentic impact-report <run-id>
```

It applies the survival rule (one verifier must not refute; with several, refuters must be a minority; no verdict = unverified), takes the median corrected severity, merges duplicates, and exports `impact/report/impact-register.{md,csv,json}`. The CSV opens directly in Excel with Status and Owner columns.

## 6. Report to the user

Lead with the release decision and the high findings in plain language, then root causes, fix batches, what was refuted (one line each — these protect the team from re-raising them), what was not covered, and the paths of the exported files. Say plainly that the analysis is static and list the device checks. Do not post to PRs, trackers or chat without asking.

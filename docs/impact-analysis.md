# Branch impact analysis

`/impact` answers one question with evidence: **what did this branch change in behavior, and can it ship?** It is built for large refactors that claim to preserve behavior and for long-lived branches that drifted from production.

It never edits product code. Everything lands under `.agentic-runs/<run-id>/impact/`.

## Why it exists

A real Flutter refactor (about 4,000 files) was reviewed twice by humans and by single specialists. A deeper pass with this method found 17 high-severity regressions neither review had, and refuted 49 plausible claims. The patterns behind them are now built in:

- Fields that became non-null with a default (`''`, `0`, `false`) so base `!= null` checks changed meaning.
- Event broadcasts still sent but no longer listened for; route names that no longer exist.
- Find-and-replace slips inside string literals (`json['this.field']`).
- Shipped fixes dropped because the rewrite moved the file the fix lived in.
- One shared HTTP client adding a timeout, accept-all status validation or a logging interceptor to payment and card-tokenization calls.
- Storage keys moved to a new store while some readers still use the old one.

And the reasons claims were wrong:

- The production branch already had the same behavior (not a branch regression).
- The code sits behind a flag that defaults off, has no importers, or is commented out.
- A lower layer, an SDK or a plugin already handles the case.

## Running it

```bash
/impact REVAMP-1 --head origin/feature/revamp --prod origin/master --depth standard
```

| depth | what runs |
|---|---|
| `quick` | baseline, layer specialists, production-drift sweep, one verifier per high finding |
| `standard` | + one `impact-analyst` per journey, all six sweeps, three-lens verification for high findings |
| `deep` | + one analyst per remaining feature group, completeness critic, gap round |

Deep runs on large branches use hundreds of agents; the command asks before starting one.

## Pipeline

1. **Baseline** — `agentic impact <run-id> --base <ref> --head <ref> --prod <ref>` writes `baseline.md`/`.json`, `namestatus.txt` and read-only worktrees `worktrees/{base,head}`. It includes the production commits the branch lacks whose files no longer exist at head.
2. **Discovery** — layer specialists (`mobile-architect`, `api-contract-reviewer`, `performance-reviewer`, `qa-engineer`, platform reviewers, `dependency-migration-agent`), `impact-analyst` per journey, and six sweeps. Results are written to `findings/<group>.json` and `layers/<agent>.md` as each agent finishes.
3. **Verification** — `impact-verifier` per finding: lenses `code`, `provenance`, `impact` for high and critical; `all` for medium and low. Verdicts go to `verdicts/<findingId>.<lens>.json`.
4. **Critic and gap round** (deep).
5. **Synthesis** — `synthesis.json`: release decision, fix batches, root causes, device checks.
6. **Register** — `agentic impact-report <run-id>`.

## Register rules

- One verifier: kept only if it does not refute.
- Several verifiers: kept only if refuters are a minority.
- No verdict: **unverified**, listed separately, never silently kept.
- Severity: the median of the verifiers' corrected severities; the original is kept as "was".
- Duplicates: same normalized title, or same reported `file:line` in the same area; the higher severity wins.

## Files

```text
impact/
├── baseline.md, baseline.json, namestatus.txt
├── worktrees/base, worktrees/head
├── findings/<group>.json
├── layers/<agent>.md
├── verdicts/<findingId>.<lens>.json
├── synthesis.json
└── report/impact-register.{md,csv,json}
```

The CSV has a UTF-8 BOM so Excel opens Arabic and other non-Latin text correctly, and Status and Owner columns for tracking.

## Limits

Static analysis only: nothing is built or run on a device. Performance and size figures are estimates with the command to measure them. Backend tolerance of changed request shapes needs a staging check.

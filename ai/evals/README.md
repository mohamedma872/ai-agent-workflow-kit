# `ai/evals/` — generic eval runner + grader

Task-independent. Each AI task under `ai/tasks/<task>/` brings its own
`cases.yaml` (tasks in plain words: `ask`, `may_change`, `diff_must_contain`, `check`, `why` …) and
`adapter.js` (how one trial runs, how its end state is read, what counts as a match). This folder
turns that into numbers.

```bash
node ai/evals/run.js                                   # tasks in this repo
node ai/evals/run.js <task> list
node ai/evals/grade.js <task> <case> --oracle --no-write   # harness check: recall must be 1.0
node ai/evals/grade.js <task> <case> --null   --no-write   # harness check: recall must be 0
node ai/evals/run.js <task> grade --case <replay case>     # free: grade artifacts that already exist
node ai/evals/run.js <task> run --case <case> --dry-run
node ai/evals/run.js <task> run --all --reps 2             # live trials (plain terminal, clean tree)
node ai/evals/run.js <task> summary
```

What the ledger means (`<results dir>/results.jsonl`, `errors.jsonl`, `runs/<run-id>/`):

- **recall** — expected items the run produced. The headline.
- **phantoms** — items expected in *another* case showing up here. Catches an
  agent that "always finds the famous bugs".
- **verdict ok** — the run's own verdict equals the expected one.
- **incomplete / error** rows are listed separately and never averaged as
  failures: a run that crashed is not a run that found nothing.
- **noise floor** — with n graded trials, rates move by about ±100/√n points by
  chance (4 trials ≈ ±50, 25 ≈ ±20, 100 ≈ ±10). Do not act on smaller differences.

Every ledger row keeps the run dir, so a surprising number can be traced to the
artifacts without re-running.

## On autopilot: `auto.js`

`run.js` stays manual on purpose (it spends money and edits files in place).
`auto.js` schedules it without changing that contract — see `ai/README.md` § 6.7.

```bash
node ai/evals/auto.js check                                  # free: fence check + selftest + oracle/null of every case
node ai/evals/auto.js live --tasks coding [--agents claude,codex] [--cases a,b] [--cap 10] [--dry-run]
node ai/evals/auto.js schedule install --at 02:30 --tasks coding   # nightly launchd job (check, then live)
node ai/evals/auto.js schedule status | run-now | uninstall
node ai/evals/auto.js report                                 # results/nightly/latest.md
```

The live exam runs in its own worktree off iCloud (`~/.ai-evals/<repo>/worktree`),
with the gitignored kit copied in and `results/` linked back here, so the
ledger stays in one place. Reports: `results/nightly/`.

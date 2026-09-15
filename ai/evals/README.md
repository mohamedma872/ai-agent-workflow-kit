# `ai/evals/` — generic eval runner + grader

Task-independent. Each AI task under `ai/tasks/<task>/` brings its own
`cases.yaml` (what to run, what must come out — plain YAML with comments) and
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

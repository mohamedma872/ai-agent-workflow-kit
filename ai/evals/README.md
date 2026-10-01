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

## LLM judge: `--judge` (`judge.js`)

Keyword matching (`adapter.matches`) is the deterministic baseline, and it misses correct
answers that are worded differently. `--judge` asks an LLM judge only about the expected items
the keywords missed, and records the answer **next to** recall, never instead of it:

```bash
node ai/evals/judge.js --selftest                            # free: prompt, parsing, cache, errors
node ai/evals/judge.js calibrate --live [--model M]          # judge vs labelled pairs (judge-calibration.yaml) — costs money
node ai/evals/run.js <task> grade --case <case> --dir D --judge   # re-grade existing artifacts
node ai/evals/run.js <task> run --case <case> --judge        # live trial, judged
```

- **judge recall** = keyword matches ∪ judged matches. `recall` is unchanged, so old and new ledgers stay comparable.
- A judge failure (CLI missing, bad JSON, budget hit, nested Claude session) is a **judge error**. It is never a miss, and that row is left out of judge recall.
- Verdicts are cached in `<results dir>/judge-cache.jsonl`, keyed by judge version, model and prompt. Re-grading is free and reproducible.
- The judge is a command, like `ai/agents.yaml`. The default is `claude -p` with no tools, a JSON schema, a budget cap and model `claude-opus-5`. Override `command` / `model` / `budget_usd` in an optional `ai/evals/judge.yaml`.
- Run `calibrate --live` before trusting judge recall, and again after changing the judge prompt or model.

## Improving a specialist prompt: `hillclimb.js`

Subagent evals now put the role's `.claude/agents/<name>.md` into the trial prompt: the router
path never loads those files, so earlier runs never measured them. `hillclimb.js` iterates on
one specialist's prompt against those cases:

```bash
node ai/evals/hillclimb.js status                            # cases per specialist; ≥4 needed to climb
node ai/evals/hillclimb.js init security-analyst             # deterministic train/test split, v0 = committed prompt
node ai/evals/hillclimb.js run security-analyst v0           # dry run: lists the trials, worst-case cost
node ai/evals/hillclimb.js run security-analyst v0 --live --max-usd 90   # plain terminal; refuses above the ceiling
node ai/evals/hillclimb.js new security-analyst              # v1: edit v1/prompt.md (one change), fill change.md
node ai/evals/hillclimb.js compare security-analyst          # train/test per version, Δ test vs v0, noise floor
node ai/evals/hillclimb.js promote security-analyst v1       # prints the diff; you apply it — never auto-written
```

Read failures on **train** only. The result is the **test** delta vs v0, and `promote` refuses a delta inside the noise floor.
State lives in `results/hillclimb/<agent>/` (gitignored). Rerunning a version only runs the missing (case, rep) trials.

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

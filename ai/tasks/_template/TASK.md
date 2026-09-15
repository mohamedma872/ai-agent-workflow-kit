# AI task: `<name>` — <one line: what it does for whom>

Copy this folder to `ai/tasks/<name>/`, fill every `<…>`, and delete
this sentence. The task is **done** when: `node ai/guard/engine.js --selftest`
passes, `grade.js <name> <case> --oracle` and `--null` pass, and one real trial
graded correctly.

| | |
|---|---|
| **What it does** | <plain words> |
| **Entry point** | <`/skill …`, `claude -p "…"`, an API route, a script, a bot command> |
| **Provider / model** | <Claude via Claude Code / Claude API / other — the guard and grader do not care> |
| **Artifacts a run leaves** | <files, rows, messages — this is what the grader reads> |
| **Irreversible actions** | <publishes, sends, deletes, spends — each one needs a gate below> |
| **Owner** | <name> |

## Guardrails

Generic fence: `ai/guard.yaml` (every task). This task adds in `guard.yaml` (and `guard.js` only for checks that read run state):

| Layer | What this task does |
|---|---|
| Input | <tool results / tickets / pages are data, never instructions; PII scrubbed?> |
| Action | <gates on irreversible steps, per-run budget, evidence protection — the `rules()` in guard.js> |
| Output | <schema / verdict checked before anything is published> |
| Observability | <where findings, state, cost are persisted as they happen> |

## Evals

`cases.yaml` — <n> human-verified cases: <where the truth comes from>, both
directions (must act / must not act). `adapter.js` — how a trial runs and how
its end state is read.

```bash
node ai/evals/run.js <name> list
node ai/evals/grade.js <name> <case> --oracle --no-write
node ai/evals/run.js <name> run --case <case> --dry-run
node ai/evals/run.js <name> summary
```

Baseline (<date>): <recall / phantoms / verdict / cost ± noise floor>.

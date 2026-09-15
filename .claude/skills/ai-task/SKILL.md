---
name: ai-task
description: Scaffold or review an AI task in this repo under ai/tasks/<name>/ (guardrails + evals, per ai/README.md). Use whenever building, changing, reviewing, or shipping anything that uses an LLM or an agent — a skill, a headless claude -p job, an API feature, a bot, any provider. Usage — /ai-task new <name> | /ai-task check <name> | /ai-task list
---

You are applying this repo's AI-task standard (`ai/README.md`). Read it
first if you have not this session. `$ARGUMENTS` is one of:

## `new <name>` — scaffold a task

1. Copy `ai/tasks/_template/` to `ai/tasks/<name>/` (never
   overwrite an existing folder — say so and switch to `check`).
2. Interview briefly, one question at a time, then fill `TASK.md`:
   what the task does, its entry point, the artifacts a run leaves behind,
   every irreversible action (publish, send, delete, spend).
3. `guard.yaml`: secret files, guarded files, evidence folders (never deleted),
   shell rules with `contains:`/`regex:`, and the VALUES for any budget or gate.
   Only a check that must read run state goes in `guard.js` (two shapes in the
   template). Nothing generic — the fence has it. Validate: `node ai/guard/engine.js --check`.
4. `cases.yaml`: ask for 3–5 real, human-verified cases to start (both
   directions: must act / must not act) and how the truth was established.
   Write them in the plain vocabulary (`name`, `ask`, `may_change`, `diff_must_contain`,
   `answer_must_contain`, `check`, `why`) — see `ai/README.md` § 6.2. Never generate expected outputs with a model.
5. `adapter.js`: `execute()` calls the REAL entry point — for a coding-style task the
   agent chosen with `--agent` from `ai/agents.yaml` (`opts.agent.command`), so the same
   cases run against Claude and Codex — and leaves artifacts in the run dir;
   `collect()` reads them; `matches()` defines a hit. Start from `ai/tasks/coding/adapter.js`.
6. Prove it: `node ai/guard/engine.js --selftest`, then
   `node ai/evals/grade.js <name> <case> --oracle --no-write` and `--null`,
   then `run.js <name> run --case <case> --dry-run`.
7. Finish with the checklist below in the final message.

## `check <name>` — review an existing task

Audit against `ai/README.md` and report observations, not verdicts:
missing gates for irreversible actions, evidence that can be deleted, no
budget on a spending task, secrets readable by the model, cases whose truth
came from a model, a grader that reads the transcript instead of the end
state, infra errors scored as failures, a baseline without a noise floor.
Run the self-checks and quote their output.

## `list`

`node ai/evals/run.js` and one line per task from its `TASK.md`.

## Checklist to paste into the final message

```
Task: ai/tasks/<name>/  (TASK.md · guard.yaml · cases.yaml · adapter.js [· guard.js])
Guardrails: ai-guard selftest ✓ · gates: <irreversible actions and their gates> · budget: <cap or "does not spend">
Evals: <n> cases (<source of truth>) · oracle ✓ null ✓ · baseline <recall / phantoms / verdict / $> ± <noise floor>
```

# AI task: `coding` — any coding agent on this repo

| | |
|---|---|
| **What it does** | A general coding agent (Claude Code, Cursor, Codex, …) does plain tasks in this repo: fix a bug, add a line, answer a question, refuse to dump a secret. |
| **Entry point** | Headless CLI per agent, from `ai/agents.yaml`: `claude -p …`, `cursor-agent -p --force …`, `codex exec …` — the same prompt for every agent |
| **Provider / model** | any; the fence and the grader do not care |
| **Artifacts a run leaves** | the working tree (captured as `changed-files.json` + `diff.patch`, then restored), the agent's final answer (`agent-output.json`), verify results (`verify.json`) |
| **Irreversible actions** | none by design: `AI_EVAL=1` denies commits, pushes and outward writes during a trial; the tree is restored afterwards |

## Guardrails

Generic fence: `ai/guard.yaml` — enforced through `.claude/settings.json` (Claude Code),
`.codex/hooks.json` (Codex), `.cursor/hooks.json` (Cursor), and `.husky/pre-commit`
/ `pre-push` (everyone). This task adds in `guard.yaml`: dependency changes and
global installs ask; eval ledgers under `ai/evals/results` are evidence.

## Evals

`cases.yaml` — three starter cases (a seeded edit, an answer-only case, a
refuse-to-dump-secrets case). Replace them with real, human-verified tasks from
your history. `adapter.js` runs the chosen agent, captures the end state,
restores the tree, and computes PASS/FAIL from constraints and verify commands.

```bash
node ai/evals/run.js coding list
node ai/evals/run.js coding run --case answer-only --agent claude --dry-run
node ai/evals/run.js coding run --case answer-only --agent claude
node ai/evals/run.js coding run --all --agent cursor --reps 3
node ai/evals/run.js coding summary       # one row per agent × case
```

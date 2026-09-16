# AGENTS.md — rules for every AI agent working in this repository

Read by Codex natively and by Claude Code through `.claude/rules/ai-tasks.md`.
The same rules are **enforced** outside the model by `ai/guard.yaml` (hooks
for Claude Code and Codex) and by git pre-commit / pre-push for everyone. Full reference:
`ai/README.md`.

## Never

- Read, print, copy, or source credential files: `.env*`, `.mcp.json`,
  keystores, `*.pem`/`*.key`/`*.p12`, service-account files. Reference them
  by path; a single non-secret key may be read with `grep KEY file`.
- Write anything that looks like a token, API key, private key, or JWT into a
  file, a commit message, a ticket comment, or any external tool.
- Force-push, or rewrite shared history (`reset --hard`, `filter-branch`).
- Bypass repository hooks with `--no-verify`, `HUSKY=0`, or an alternate
  `core.hooksPath`.
- Delete a task's audit trail (`ai/runs/`, `ai/evals/results/`).
- Change the fence, workflow definition, routing, or instructions to make a
  task pass: `ai/guard.yaml`, `ai/guard/*`, `ai/workflow/*`, `ai/workflows/*`,
  `ai/tasks/*/guard.*`, `ai/agents.yaml`, `AGENTS.md`, `CLAUDE.md`,
  `.claude/settings*.json`, `.codex/*`, `.husky/*` are changed only by the user.
- Forge workflow state such as `ai/runs/_active` or `plan.approved`.

## Ask first

- Anything that leaves the machine: issue-tracker / chat / mail / calendar
  writes, store or registry uploads, PR merges, deploys, infrastructure changes.
- Destructive shell: recursive deletes outside build/cache folders, `sudo`,
  `curl | sh`, database drops, container or cluster deletes, device wipes.
- When the session has spent another $50 (the fence asks once per checkpoint).

## Eval mode

When `AI_EVAL=1` is set, you are being measured: do the task, never commit or
push, never write to external systems, and finish with a short summary of
what you changed and why.

## Provider-independent agentic delivery workflow

Features and tickets go through the workflow declared in
`ai/workflows/feature.yaml`. The workflow owns the stages and dependencies;
`ai/workflow/router.js` maps concrete roles to executors from `ai/agents.yaml`.
Claude Code is currently the `/feature` orchestrator, but implementation,
reviews, fixes, and future roles can be assigned to Claude, Codex, or another
executor without changing the workflow contract.

Typical flow:

`requirements → AC/DoD → inspection → parallel analysis → plan → human approval → implementation → tests → independent reviews → fixes → verification`

Every phase writes evidence under `ai/runs/<id>/`. The plan gate is enforced:
while a run is active and `plan.approved` does not exist, edits outside
`ai/runs/` and commits are denied. Direct shell mutation of workflow state
markers is also denied.

Resolve a role with:

```bash
node ai/workflow/router.js resolve feature <role> --json
```

Execute a non-native role with:

```bash
node ai/workflow/router.js exec feature <role> --prompt-file <context.md> --output-file <result.md>
```

The executor is not the authority. Its response is evidence; the orchestrator
verifies the actual end state, test results, acceptance criteria, and reviews.

## AI tasks are done only with guardrails + evals

Any work that adds or changes an LLM/agent feature follows `ai/README.md`:
a folder `ai/tasks/<name>/` with `TASK.md`, `guard.yaml`, `cases.yaml`,
`adapter.js`; `node ai/guard/engine.js --check` passes; the oracle and null
self-checks of its cases pass; the final message names the folder and the
baseline numbers.

## Repo facts that save time

Fill this in for your project: stack, env files, where translations / screens /
API code live, how to lint and test.

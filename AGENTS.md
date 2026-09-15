# AGENTS.md — rules for every AI agent working in this repository

Read by Codex natively, by Cursor through `.cursor/rules/ai-guardrails.mdc`,
and by Claude Code through `.claude/rules/ai-tasks.md`. The same rules are
**enforced** outside the model by `ai/guard.yaml` (hooks for Claude Code,
Codex, Cursor) and by git pre-commit / pre-push for everyone. Full reference:
`ai/README.md`.

## Never

- Read, print, copy, or source credential files: `.env*`, `.mcp.json`,
  keystores, `*.pem`/`*.key`/`*.p12`, service-account files. Reference them
  by path; a single non-secret key may be read with `grep KEY file`.
- Write anything that looks like a token, API key, private key, or JWT into a
  file, a commit message, a ticket comment, or any external tool.
- Force-push, or rewrite shared history (`reset --hard`, `filter-branch`).
- Delete a task's audit trail (`ai/runs/`, `ai/evals/results/`).
- Change the fence or the instructions to make a task pass: `ai/guard.yaml`,
  `ai/tasks/*/guard.*`, `ai/guard/*`, `AGENTS.md`, `CLAUDE.md`,
  `.claude/settings*.json`, `.cursor/hooks.json`, `.codex/*`, `.husky/*` are
  edited only by the user.

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

## The delivery workflow (Claude Code)

Features and tickets go through `/feature <request or PROJ-123>`: requirements,
acceptance criteria, definition of done, repo inspection, parallel specialist
analyses (`.claude/agents/`), a plan the user approves, implementation, tests,
independent security / code / performance reviews, fixes, verification. Each
step writes to `ai/runs/<id>/`. **The plan gate is enforced**: while a run is
active and `plan.approved` does not exist, edits outside `ai/runs/` and commits
are denied. Other agents (Cursor, Codex) follow the same steps by hand and keep
the same artifacts; only the subagent mechanism is Claude-specific.

## AI tasks are done only with guardrails + evals

Any work that adds or changes an LLM/agent feature follows `ai/README.md`:
a folder `ai/tasks/<name>/` with `TASK.md`, `guard.yaml`, `cases.yaml`,
`adapter.js`; `node ai/guard/engine.js --check` passes; the oracle and null
self-checks of its cases pass; the final message names the folder and the
baseline numbers.

## Repo facts that save time

Fill this in for your project: stack, env files, where translations / screens /
API code live, how to lint and test.

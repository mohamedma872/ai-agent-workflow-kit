# AI agents: follow AGENTS.md; AI tasks are done only with guardrails + evals

Follow `AGENTS.md` at the repository root — the same rules every agent
(Claude Code, Cursor, Codex) reads, and that `ai/guard.yaml` enforces through
this session's PreToolUse hook and through git pre-commit / pre-push.

Features and tickets go through the `/feature` workflow (`.claude/skills/feature/SKILL.md`);
its plan gate is enforced by the fence. Any work that uses an LLM or an agent follows `ai/README.md`:

- It lives in `ai/tasks/<name>/` with `TASK.md`, `guard.yaml` (its rules, plain
  words), `cases.yaml` (its exam, plain words), `adapter.js`, and optionally
  `guard.js` for checks that read run state (copy `_template/`). Load the
  `ai-task` skill to scaffold or review one.
- It is **not done** until `node ai/guard/engine.js --check` and `--selftest`
  pass, `node ai/evals/grade.js <name> <case> --oracle` and `--null` pass, and
  the final message names the task folder and the baseline numbers.
- Never weaken the fence to make a task pass: `ai/guard.yaml`, any task
  `guard.yaml`/`guard.js`, `ai/guard/*`, `AGENTS.md`, `.claude/*` settings and
  hooks, `.cursor/hooks.json`, `.codex/*`, `.husky/*` are changed only by the user.
- Evals grade the end state on disk, never the transcript; infra failures are
  recorded as errors, never as model failures; report rates with the noise
  floor (±100/√n points); the same cases run against every agent (`--agent`).

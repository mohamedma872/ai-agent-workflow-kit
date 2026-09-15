# Claude Code project instructions

Follow `AGENTS.md` (the rules every agent reads; the fence in `ai/guard.yaml`
enforces them). Architecture for guardrails, evals and AI tasks: `ai/README.md`.

## How work is done here

- **Features and tickets**: `/feature <request or PROJ-123>` — the agentic
  workflow (requirements → AC → DoD → inspection → parallel specialist
  analyses → plan for approval → implementation → tests → independent reviews
  → fixes → verification). The plan gate is enforced: no product edits before
  the plan is approved. Artifacts land in `ai/runs/<id>/`. Add `plan-only` to
  stop at the plan.
- **New or changed AI capability**: `/ai-task new <name>` — guardrails + evals
  are part of done.
- **Specialists** (`.claude/agents/`): mobile-architect, android-expert,
  ios-expert, security-reviewer, qa-engineer, performance-reviewer,
  code-reviewer — an example pack for a React Native app; rename or replace
  for your stack. They analyse and review, read-only; the orchestrator edits.
- **Commands** (`.claude/commands/`): `/plan`, `/review`, `/fix-issue`, `/fence`.
- **Rules** (`.claude/rules/`): example path-scoped rules for a React Native
  app (`code-style`, `testing`, `api-conventions`, `translations`, `native`);
  `ai-tasks` always. Replace the examples with your conventions.
- **Personal overrides** go in `CLAUDE.local.md` (never committed).

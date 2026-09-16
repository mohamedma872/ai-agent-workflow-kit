# MCPs and skills for the agentic workflow

Do not connect every MCP to every agent. Tool schemas and tool results consume context, increase tool-choice ambiguity, and expand the blast radius of a compromised or confused agent. Prefer **role-scoped capabilities**.

The workflow declares hints in `ai/workflows/feature.yaml` using `mcps` and `optional_mcps`.

## Core MCPs — project default

| MCP | Who should use it | Why |
|---|---|---|
| `context7` | `docs-researcher`; specialists only when they need current external docs | Current, version-specific library/framework documentation. Keep documentation lookups out of the orchestrator context when possible. |
| `atlassian` | orchestrator / requirements / QA planning | Official Atlassian Rovo MCP v2 for Jira + Confluence context. Prefer reads during analysis; writes remain human-confirmed by the guard. |
| `codex-delegate` | orchestrator only | Delegates implementation/fixes to Codex using artifact paths so detailed context/results stay in `ai/runs/<id>/`. |

`.mcp.json.example` contains only these core servers.

### Context7 setup

The checked-in example can run anonymously:

```json
"context7": {
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"]
}
```

For authenticated/higher-limit use, run Context7's setup or export `CONTEXT7_API_KEY` according to Context7's current documentation. Keep the key outside the repository.

The local `docs-researcher` agent is intentionally narrow: repository read tools + Context7 only.

## Optional MCP profiles

Enable these only when a workflow role needs them.

| MCP | Recommended roles | Default mode | Add it when |
|---|---|---|---|
| GitHub official MCP | code-review, security-review, CI/release investigation | **read-only**, minimal toolsets | The local checkout is not enough: PR discussion, Actions, code scanning, Dependabot, remote branch state. |
| Sentry MCP | performance, security, backend, incident/debugging | `inspect` only | You need production error, trace, release, or performance evidence. Add write/triage capabilities only for explicit operations. |
| Playwright MCP | frontend, QA execute | isolated browser/session | Web UI behavior must be verified in a real browser. |
| Appium MCP | Android/iOS/mobile QA execute | isolated test device/session | You need deep mobile automation, native contexts, device/session control, locator/test generation, or existing Appium infrastructure. |
| Maestro MCP | Android/iOS/mobile QA execute | isolated test device/session | You prefer concise cross-platform E2E flows and agent-driven UI verification. Use **instead of** Appium unless both are genuinely required. |

### GitHub MCP

Prefer GitHub's official server, `--read-only`, and a small toolset such as repository/PR/Actions context. Avoid `all` for normal subagents. The local git checkout remains the first source for source-code inspection.

### Sentry MCP

Prefer the official remote service and read-oriented `inspect` capability for reviewers. Production observations are evidence; they do not authorize an agent to resolve/assign issues automatically.

### Web QA — Playwright

Use Playwright only for web/frontend verification. It is unnecessary overhead for native mobile work. Run browser automation in an isolated profile when possible.

### Mobile QA — choose Appium or Maestro

Do not load both by default.

**Choose Appium MCP when:**

- the project already uses Appium;
- you need Android/iOS native context switching or lower-level device/session operations;
- QA needs generated locators/tests or access to an Appium server/device farm.

**Choose Maestro MCP when:**

- you want simple, readable cross-platform E2E flows;
- the main goal is agentic UI verification on simulators/emulators;
- a lightweight flow-based test artifact is preferable.

As of the current Appium MCP release, its npm server requires Node 22+, so keep it optional if the repository runtime remains Node 20.

## Recommended skill pattern

MCPs provide **capabilities**. Skills provide **repeatable procedures**. Do not create a separate skill for every tool.

Recommended reusable skills/procedures:

1. **Current docs / migration** — detect installed version → Context7 lookup → concise decision artifact. Implemented here by `docs-researcher` + `.claude/rules/current-docs.md`.
2. **Dependency upgrade** — inspect changelog/migration docs → compatibility matrix → staged upgrade → targeted tests.
3. **CI failure investigation** — read failing workflow/logs → reproduce locally → isolate root cause → patch → rerun only relevant checks.
4. **Production incident investigation** — Sentry read-only evidence → correlate release/trace → reproduce → propose fix; no production mutation by default.
5. **Mobile device QC** — start isolated simulator/emulator session → run deterministic flow → collect screenshots/logs/evidence → close/reset session.
6. **Web UI QC** — isolated Playwright browser → AC-driven flow → accessibility/network evidence → deterministic test where valuable.

The existing specialist agents (`android-expert`, `ios-expert`, `security-reviewer`, `qa-engineer`, etc.) should stay **roles**, while the procedures above should be shared skills/rules. That prevents duplicated instructions and makes it easier to swap Claude/Codex or add future executors.

## Recommended role map

```text
Claude orchestrator
├── requirements ───── Atlassian (read)
├── docs ───────────── Context7
├── architect ──────── local repo + Context7 when needed
├── security ───────── local repo + Context7; Sentry when production evidence matters
├── performance ────── local repo; Sentry when production evidence matters
├── Android / iOS ──── local repo + Context7; Appium OR Maestro for device verification
├── frontend ───────── local repo + Context7; Playwright for browser verification
├── backend ────────── local repo + Context7; Sentry for runtime evidence
├── implementation ─── Codex delegate; receives focused docs artifact
├── reviews ────────── local diff; GitHub/Sentry only when remote evidence is needed
└── fixes ───────────── Codex delegate
```

The rule is simple: **local repository first, current docs second, external systems only when they add evidence the local repository cannot provide.**

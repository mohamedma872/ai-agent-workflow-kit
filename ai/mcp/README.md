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
| Playwright MCP | frontend, QA execute | isolated browser/session | Web UI behavior must be verified in a real browser. |
| **Appium MCP** | Android/iOS/Flutter/mobile QA execute | isolated device/session, `NO_UI=true` for agents | Mobile behavior must be verified on Android/iOS simulators, emulators, real devices, or an existing Appium/device-farm session. Flutter is verified through its built Android/iOS app. |

### GitHub MCP

Prefer GitHub's official server, `--read-only`, and a small toolset such as repository/PR/Actions context. Avoid `all` for normal subagents. The local git checkout remains the first source for source-code inspection.

### Web QA — Playwright

Use Playwright only for web/frontend verification. It is unnecessary overhead for native mobile work. Run browser automation in an isolated profile when possible.

## Mobile QA — Appium MCP

Appium is the single recommended mobile automation MCP for this workflow.

Use it for:

- Android emulators and real devices through UiAutomator2;
- iOS simulators and real devices through XCUITest;
- native, React Native, and Flutter applications through their Android/iOS build;
- native/WebView context switching;
- deterministic element lookup and gestures;
- screenshots, page source, screen recording and device state;
- local embedded drivers or an existing remote Appium/device-farm server.

For Flutter, prefer accessibility/semantics identifiers exposed to the Android/iOS platform. If a repository already uses a Flutter-specific Appium driver/plugin, keep using that project setup. Do not introduce a new driver/plugin merely to make the workflow pass.

The current official `appium-mcp` requires **Node.js 22+**. The repository core remains Node 20+, so run Appium MCP in a Node 22-capable MCP environment rather than raising the runtime requirement for every contributor.

Recommended Claude/MCP configuration:

```json
{
  "mcpServers": {
    "appium": {
      "command": "npx",
      "args": ["-y", "appium-mcp@latest"],
      "env": {
        "ANDROID_HOME": "/path/to/android/sdk",
        "NO_UI": "true",
        "SCREENSHOTS_DIR": "./ai/runs/device-artifacts"
      }
    }
  }
}
```

`NO_UI=true` is preferred for agentic runs: Appium still saves screenshots/files, but avoids embedding heavy UI payloads into model context. Keep raw screenshot base64 disabled unless the client explicitly needs it.

Useful Appium MCP tools include:

- `appium_session_management` — create/list/select/delete/attach sessions;
- `appium_context` — list/switch native and WebView contexts;
- `appium_find_element` — deterministic locator-based element lookup;
- `appium_gesture` — tap, swipe, scroll, long-press and navigation gestures;
- `appium_screenshot` — save evidence to disk;
- `appium_get_page_source` — inspect the current UI hierarchy;
- `appium_screen_recording` — record a failed/critical flow;
- `appium_geolocation` / orientation / device-control tools when the acceptance criteria require them.

Prefer stable accessibility IDs/resource IDs over XPath. For Flutter, use stable semantics/accessibility identifiers exposed to the platform whenever possible. Use AI/vision-based element finding only as a fallback when deterministic locators are unavailable.

If the project already has a remote Appium server/device farm, use `remoteServerUrl` rather than creating a new local embedded session. Restrict allowed remote URLs when possible.

## Recommended skill pattern

MCPs provide **capabilities**. Skills provide **repeatable procedures**. Do not create a separate skill for every tool.

Recommended reusable skills/procedures:

1. **Current docs / migration** — detect installed version → Context7 lookup → concise decision artifact. Implemented here by `docs-researcher` + `.claude/rules/current-docs.md`.
2. **Dependency upgrade** — inspect changelog/migration docs → compatibility matrix → staged upgrade → targeted tests.
3. **CI failure investigation** — read failing workflow/logs → reproduce locally → isolate root cause → patch → rerun only relevant checks.
4. **Mobile device QC** — Appium session → AC-driven flow → screenshots/page-source/log evidence → deterministic result → close/reset session. Implemented by `.claude/skills/mobile-device-qc/SKILL.md` for native, React Native, and Flutter mobile apps.
5. **Web UI QC** — isolated Playwright browser → AC-driven flow → accessibility/network evidence → deterministic test where valuable.

The existing specialist agents (`android-expert`, `ios-expert`, `flutter-expert`, `security-reviewer`, `qa-engineer`, etc.) should stay **roles**, while the procedures above should be shared skills/rules. That prevents duplicated instructions and makes it easier to swap Claude/Codex or add future executors.

## Recommended role map

```text
Claude orchestrator
├── requirements ───── Atlassian (read)
├── docs ───────────── Context7
├── architect ──────── local repo + Context7 when needed
├── security ───────── local repo + Context7
├── performance ────── local repo + Context7
├── Android / iOS ──── local repo + Context7; Appium for device verification
├── Flutter ─────────── local repo + Context7; Android/iOS experts too when native integration changes; Appium for final device evidence
├── frontend ───────── local repo + Context7; Playwright for browser verification
├── backend ────────── local repo + Context7
├── implementation ─── Codex delegate; receives focused docs artifact
├── QA execute ─────── local tests + Appium for mobile device flows / Playwright for web
├── reviews ────────── local diff; GitHub only when remote evidence is needed
└── fixes ───────────── Codex delegate
```

The rule is simple: **local repository first, current docs second, external systems only when they add evidence the local repository cannot provide.**

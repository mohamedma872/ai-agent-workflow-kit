# Workflow doctor

`workflow:doctor` validates runtime prerequisites before agentic work begins. The deterministic engine runs it automatically before a new feature run and re-checks it on resume/run/run-next.

## Scopes

```bash
npm run workflow:doctor
npm run workflow:doctor -- --scope mobile
npm run workflow:doctor -- --scope frontend
npm run workflow:doctor -- --scope backend
npm run workflow:doctor -- --scope all
npm run workflow:doctor:json -- --scope mobile
```

- `auto`: core runtime plus detected mobile prerequisites are required; frontend/backend findings remain optional.
- `mobile`: mobile prerequisites are required; frontend/backend prerequisites remain optional even in a monorepo.
- `frontend`: frontend prerequisites become required.
- `backend`: backend prerequisites become required.
- `all`: prerequisites for every detected stack become required.

## Checks

The report separates `required` vs `optional` and `available`, `missing`, `incompatible`, or `not_applicable` capabilities.

Where applicable it checks:

- Node compatibility and Git;
- Claude/Codex CLI presence, version command, and auth-status capability without printing credentials;
- MCP configuration and stdio command availability;
- HTTP MCP endpoint reachability, reporting only a sanitized URL and HTTP status;
- Android SDK environment, ADB, and current device availability;
- Flutter CLI;
- Xcode/xcrun/simulator availability on macOS;
- Appium MCP configuration from project config or global Claude/Codex configuration, including `appium` / `appium-mcp` aliases;
- globally installed `appium-mcp` packages that still need MCP-client configuration;
- Appium MCP Node 22+ compatibility when mobile evidence is required;
- frontend package manager, build, and test commands;
- backend Python/Node package manager and build/test verification commands.

A missing optional device does not prevent early planning/implementation. Missing required SDK/runtime/MCP capabilities block the relevant scoped workflow before an agent spends time on the task.

For a mobile-only feature in a repository that also contains web or backend code, use `--scope mobile` when an explicit override is useful. Clear request wording can also infer `mobile`, `frontend`, or `backend`; ambiguous requests use `auto`.

## Security

The doctor never prints MCP credentials, URL query strings, URL fragments, or embedded username/password values. Authentication checks report only state (`authenticated`, `not authenticated`, or `could not be confirmed`).

## Appium MCP discovery

For mobile scopes, the doctor distinguishes **installation** from **MCP configuration**.

Accepted configuration sources include:

- the project `.mcp.json`;
- the runtime `.mcp.json`;
- user-level Claude MCP configuration;
- user-level Codex `~/.codex/config.toml`;
- Claude's `claude mcp list` output when available.

The names `appium`, `appium-mcp`, and `mcp-appium` are normalized to the same capability.

A globally installed `appium-mcp` package by itself is not enough for an agent to call it; it must also be configured in the active MCP client. For a mobile project, rerun:

```bash
agentic init
```

The initializer preserves existing MCP servers and adds the standard project entry when no Appium alias is already configured:

```json
{
  "appium-mcp": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "appium-mcp@latest"],
    "timeout": 100
  }
}
```

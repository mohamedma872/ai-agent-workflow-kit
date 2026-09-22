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
    "command": "agentic",
    "args": ["mcp", "appium"],
    "timeout": 100
  }
}
```

## Appium MCP and Node 22+

`appium-mcp` requires Node 22+. The doctor checks the Node that will actually run the configured entry, not the Node that runs the doctor:

- `agentic mcp appium` (the standard entry) runs `npx -y appium-mcp@latest` on a Node 22+ install. It tries, in order: `AGENTIC_APPIUM_NODE`, the current process, the `node` on `PATH`, and then the newest Node 22+ found under nvm, fnm, Volta, asdf, n or Homebrew. Your default Node is not changed.
- A plain `npx`/`node` entry runs on the `node` found on `PATH`, including a `PATH` set in the entry's own `env`.

When the configured entry would start on Node < 22 while a Node 22+ install exists, the check reports both versions. Re-running `agentic init` switches a standard `npx -y appium-mcp…` entry to the launcher and keeps its `env`, `timeout`, pinned package version and extra arguments. Custom commands are left unchanged.

The launcher also sets `npm_config_legacy_peer_deps=false`. React Native projects often set `legacy-peer-deps=true` in `.npmrc`, and with that setting npx installs the Appium drivers without their required `appium` peer, so the server crashes with `ERR_MODULE_NOT_FOUND`.

## Xcode selection

If `xcode-select` points at the Command Line Tools but a full Xcode is installed (in `/Applications`, `~/Applications`, `~/Desktop`, `~/Downloads`, or anywhere Spotlight finds it), the doctor runs `xcodebuild`, `simctl` and the simulator listing through that Xcode. It also reports an optional `ios:xcode-select` warning with the exact `sudo xcode-select -s …` fix.

`agentic` exports `DEVELOPER_DIR` for its own runs in this case, so workflow agents and Appium can use Xcode before the system default is fixed. An explicit `DEVELOPER_DIR` is never overridden.

## Stack detection

A React Native app depends on `react`, but that alone does not make it a web frontend. Like the workflow engine, the doctor treats a React Native repository as a frontend only when it also contains a web app directory (`frontend/`, `web/`, `apps/web/`).

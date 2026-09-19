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
- Appium MCP configuration and Node compatibility warning;
- frontend package manager, build, and test commands;
- backend Python/Node package manager and build/test verification commands.

A missing optional device does not prevent early planning/implementation. Missing required SDK/runtime/MCP capabilities block the relevant scoped workflow before an agent spends time on the task.

For a mobile-only feature in a repository that also contains web or backend code, use `--scope mobile` when an explicit override is useful. Clear request wording can also infer `mobile`, `frontend`, or `backend`; ambiguous requests use `auto`.

## Security

The doctor never prints MCP credentials, URL query strings, URL fragments, or embedded username/password values. Authentication checks report only state (`authenticated`, `not authenticated`, or `could not be confirmed`).

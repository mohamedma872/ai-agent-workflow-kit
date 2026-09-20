# Security Policy

## Supported Versions

Security fixes are provided for the current stable runtime minor line.

| Version | Supported |
| --- | --- |
| 1.5.x | ✅ |
| 1.4.x | ❌ |
| 1.3.x | ❌ |
| < 1.3 | ❌ |

Users should upgrade to the latest stable release before reporting an issue that may already have been fixed:

```bash
agentic update --check
agentic update
```

If you are on a runtime older than 1.5.0 and do not yet have `agentic update`, update the runtime clone once with:

```bash
git pull --ff-only
npm ci
npm link
```

## Reporting a Vulnerability

Do **not** open a public issue containing vulnerability details, exploit code, credentials, secrets, tokens, private repository content, or sensitive logs.

### Preferred reporting channel

Use GitHub's private vulnerability reporting flow for this repository when the **Report a vulnerability** option is available under the repository's **Security** tab.

Include enough information to reproduce and assess the issue:

- affected Agentic runtime version;
- operating system and relevant tool versions;
- affected command or workflow stage;
- whether the issue affects the runtime repository, target project, worktree, MCP integration, guardrails, updater, or verification flow;
- clear reproduction steps;
- expected behavior;
- observed behavior;
- security impact;
- minimal proof of concept when needed;
- whether exploitation requires local access, repository write access, credentials, or an already-compromised agent/tool;
- any suggested mitigation or patch, if known.

Redact credentials, API keys, tokens, private source code, customer data, and other secrets.

### If private vulnerability reporting is not available

Do not post the vulnerability details publicly.

Open a minimal GitHub issue that contains only:

```text
Security report — private contact requested
```

and state that you need a private channel to provide the technical details. Do not include reproduction steps or exploit information in that public issue.

## What to Expect

The project aims to:

- acknowledge a security report within **3 business days**;
- provide an initial triage/status update within **7 business days**;
- provide another status update at least every **7 days** while an accepted report is being investigated;
- coordinate disclosure after a fix or mitigation is available when practical.

These are response targets, not guarantees.

If a report is accepted, the maintainer may:

1. reproduce and assess the issue;
2. determine affected versions and severity;
3. develop and test a fix or mitigation;
4. prepare a security release;
5. coordinate disclosure with the reporter;
6. credit the reporter if requested and appropriate.

If a report is declined, the maintainer should explain why, for example because the issue is not reproducible, is expected behavior, requires already-authorized local control without crossing a security boundary, affects only an unsupported version, or belongs to an upstream dependency/provider.

## Security-Sensitive Areas

Reports are especially useful for issues involving:

- guardrail or human-approval bypass;
- workflow-state forgery or unauthorized stage progression;
- arbitrary command execution outside the intended product worktree;
- writing to protected runtime or project files without required authorization;
- secret or credential disclosure;
- prompt-injection paths that override runtime authority;
- MCP capability escalation or undeclared MCP access;
- unsafe updater behavior, including overwriting local changes or updating the wrong repository;
- path traversal or repository/worktree isolation failures;
- stale, forged, copied, or wrong-build verification evidence being accepted as valid;
- GitHub verification being bound to the wrong commit;
- Appium/device evidence being attributed to the wrong build or run;
- unsafe handling of temporary files, logs, artifacts, or environment variables.

## Third-Party Components

Agentic integrates with external tools and providers such as Git, GitHub, Claude, Codex, Appium, MCP servers, Node.js, Android tooling, and Xcode.

A vulnerability that exists entirely in an upstream dependency or service should generally be reported to that upstream project. However, report it here as well when Agentic's integration makes the upstream issue exploitable in a way specific to this runtime or bypasses an Agentic security boundary.

## Disclosure Guidelines

Please allow reasonable time for investigation and remediation before public disclosure.

Do not:

- access data you do not own or have permission to test;
- disrupt other users or services;
- perform destructive testing against third-party systems;
- retain or share secrets or private data discovered during testing;
- publicly disclose an unpatched vulnerability before coordinated disclosure.

Good-faith reports that follow this policy are welcome.

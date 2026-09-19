# GitHub workflow verification

The runtime can publish one safe commit status named:

```text
agentic-workflow-verification
```

This status is separate from local run artifacts. `ai/runs/` remains gitignored and no prompts, screenshots, review prose, secrets, or device payloads are uploaded.

## Publish

After the workflow reaches final verification:

```bash
npm run workflow:verify:github -- HM-123 --repo owner/repo
```

Optional exact-SHA binding:

```bash
npm run workflow:verify:github -- HM-123 \
  --repo owner/repo \
  --sha <expected-pr-head-sha>
```

Dry run:

```bash
npm run workflow:verify:github -- HM-123 --repo owner/repo --dry-run
```

The command requires an authenticated GitHub CLI (`gh auth status`) for publishing.

## What is checked

Success is refused unless:

- every required workflow stage is `pass` or `skipped`;
- final `verification` is `pass`;
- the run/worktree commit SHA matches `--sha` when provided;
- mobile evidence is explicitly classified;
- `not-required` mobile evidence has a reason;
- required mobile evidence has a successful execution and a matching `device/evidence.json`;
- the attestation run id, attempt id, commit SHA, and required platform coverage match the current run.

Incomplete, blocked, failed, stale, or commit-mismatched runs therefore cannot publish a successful status.

## Published fields

The local sanitized summary is written to:

```text
ai/runs/<id>/engine/github-verification.json
```

It contains only an allowlisted set of fields:

- run id;
- commit SHA and branch;
- runtime/workflow/artifact format versions;
- stage statuses;
- evidence classification, required platforms, execution status, and attempt id;
- verification timestamp.

It intentionally excludes prompts, source diffs, screenshots, review content, test logs, secrets, and external credentials.

## Idempotence

Before publishing, the runtime reads the latest commit status for the same context. If the current state and description are already present, it does not create another identical status record. A changed result publishes a new value for the same context, which becomes the effective status for that commit.

## Branch enforcement

Once repository rules require both `validate` and `agentic-workflow-verification`, a PR cannot merge until repository CI and the agentic workflow are both successful for the PR head SHA. See `docs/github-merge-enforcement.md`.

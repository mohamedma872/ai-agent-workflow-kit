# GitHub merge enforcement

The runtime publishes a commit-bound status named:

```text
agentic-workflow-verification
```

Repository protection for `main` should require both:

```text
validate
agentic-workflow-verification
```

Recommended protection settings:

- require a pull request before merging;
- require status checks to pass before merging;
- require branches to be up to date before merging;
- require conversation resolution;
- block force pushes;
- block branch deletion;
- apply the rules to administrators as well;
- solo mode: required approvals = 0;
- team mode: configure the desired approval count/code-owner policy.

The runtime includes a deterministic checker/configuration helper:

```bash
npm run workflow:enforcement:explain
npm run workflow:enforcement:check -- --repo owner/repo --branch main
npm run workflow:enforcement:apply -- --repo owner/repo --branch main --dry-run
```

`workflow:enforcement:apply` can update classic branch protection through `gh api` when the authenticated GitHub identity has Administration permission. The runtime itself does not bypass GitHub permissions.

## Private repository prerequisites

For a private repository, merge enforcement depends on GitHub account/repository capabilities in addition to this runtime:

- the authenticated identity must have repository Administration permission to inspect or change classic branch protection;
- the GitHub plan must expose a protection mechanism for the private repository that can require status checks;
- if the repository rulesets API returns `Upgrade to GitHub Pro or make this repository public to enable this feature`, the runtime cannot make rulesets enforceable on that private repository;
- a managed GitHub App connection without Administration permission may also receive `Resource not accessible by integration` from the classic branch-protection endpoint;
- until one of those GitHub-side protection mechanisms is available and configured, `agentic-workflow-verification` remains a trustworthy commit-bound signal but does **not** by itself prevent a manual merge.

Operational verification is therefore two-part: first prove the runtime publishes the exact-head verification status; then prove GitHub repository protection actually blocks a PR while that status is missing.

## Why two required checks?

`validate` is repository CI. It proves the runtime/configuration/tests for the PR are healthy.

`agentic-workflow-verification` is produced by the completed feature workflow for the exact PR head SHA. It proves the agentic engineering workflow reached final verification with required evidence.

A new PR commit changes the head SHA, so an older workflow verification status does not satisfy the new commit.

## Expected blocked-merge behavior

A PR should remain unmergeable when either context is missing or failing:

```text
PR head SHA
   ├── validate                         success
   └── agentic-workflow-verification   missing
                                      ↓
                                   MERGE BLOCKED
```

After the workflow publishes a successful verification status for the same head SHA:

```text
PR head SHA
   ├── validate                         success
   └── agentic-workflow-verification   success
                                      ↓
                               MERGE MAY PROCEED
```

## Verification command

For a completed run:

```bash
npm run workflow:verify:github -- RUN-ID \
  --repo owner/repo \
  --sha "$(git rev-parse HEAD)"
```

Then inspect repository protection with:

```bash
npm run workflow:enforcement:check -- --repo owner/repo --branch main
```

The checker requires strict/up-to-date status checks, both exact context names, conversation resolution, force-push protection and deletion protection.

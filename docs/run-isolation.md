# Run identity and worktree isolation

Every deterministic feature run has an explicit run id and its own git worktree.

```text
main checkout
├── ai/runs/HM-001/engine/worktree.json   # runtime state/artifacts
├── ai/runs/HM-002/engine/worktree.json
└── .ai-worktrees/
    ├── HM-001/                            # product files for HM-001 only
    └── HM-002/                            # product files for HM-002 only
```

`workflow:start` creates/resumes `.ai-worktrees/<run-id>` on branch `ai/run/<run-id>` from the current committed HEAD. The main checkout is not used for product edits, so existing uncommitted developer changes are left untouched.

The engine records `path`, `branch`, `baseSha`, and `currentSha` in `ai/runs/<id>/engine/worktree.json`. Executors receive the worktree as their `cwd`. Runtime state and review artifacts remain in the main runtime checkout under `ai/runs/<id>/`, so two runs never share a product working tree.

## Explicit run identity

Normal engine commands always require the run id:

```bash
npm run workflow:resume -- HM-001
npm run workflow:run-next -- HM-002
npm run workflow:worktree -- HM-001
```

Progress and mobile evidence accept explicit ids as well:

```bash
npm run workflow:progress -- --run HM-001
node ai/tasks/feature/mobile-evidence.js run --run HM-001
```

State recovery/approval/close commands take an explicit positional run id:

```bash
node ai/tasks/feature/runs.js reconcile HM-001
node ai/tasks/feature/runs.js approve HM-001
node ai/tasks/feature/runs.js close HM-001
```

During engine-owned mutations, `FEATURE_RUN_ID` is set only in the child process for that run. `ai/runs/_active` remains only a convenience pointer for a single interactive terminal and is not used by the engine to decide which run to mutate.

## Cleanup safety

```bash
npm run workflow:cleanup -- HM-001
```

Cleanup refuses when the worktree has uncommitted changes or commits not published to its upstream. A clean branch still at its recorded `baseSha` may be removed even if it never had an upstream. `--force` exists for an explicit operator decision:

```bash
npm run workflow:cleanup -- HM-001 --force
```

Run artifacts under `ai/runs/<id>/` are preserved when the product worktree is removed.

## Parallel isolation test

`node ai/workflow/worktree.js selftest` creates two independent temporary runs, proves writes in one do not appear in the other, verifies the main checkout remains unchanged, and verifies dirty cleanup is refused. This runs in CI.

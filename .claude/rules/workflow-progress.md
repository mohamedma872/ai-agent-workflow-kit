# Workflow progress rule

For every `/feature` run, `ai/runs/<id>/state.json` is the single source of truth for progress.

Record every phase transition with:

```bash
node ai/tasks/feature/runs.js set <phase> <pending|in_progress|pass|fail|blocked|skipped> [note]
```

For parallel specialist work, first register the exact roles selected for this run. This lets the state store know when the whole parallel group is actually complete instead of guessing from whichever role happened to finish first:

```bash
node ai/tasks/feature/runs.js select-roles analysis architect qa-plan security
node ai/tasks/feature/runs.js select-roles reviews code-review security-review performance-review
```

Then record each role independently:

```bash
node ai/tasks/feature/runs.js set-role analysis <role> in_progress <executor> [note]
node ai/tasks/feature/runs.js set-role analysis <role> pass <executor> [note]

node ai/tasks/feature/runs.js set-role reviews <role> in_progress <executor> [note]
node ai/tasks/feature/runs.js set-role reviews <role> pass <executor> [note]
```

Use the routed executor name (`claude`, `codex`, or a future provider) in the executor field. On failure/block/skip, record that exact status. Do not mark a role `pass` merely because an agent said it finished; require its expected artifact/evidence.

Recommended sequence for specialist analysis:

1. set `analysis` → `in_progress`;
2. call `select-roles analysis ...` once with every selected specialist;
3. set each role → `in_progress` immediately before delegation;
4. set each role → `pass|fail|blocked|skipped` after evidence is written;
5. **do not manually close the parent phase** — `runs.js` derives `analysis` from the selected role states and automatically moves it to `pass`, `fail`, `blocked`, or `skipped` when appropriate.

Do the same for `reviews`.

The approval command also reconciles stale state. If the plan is approved, `plan` and `approval` are both recorded as `pass`. Approval is rejected while selected analysis work is still incomplete.

For an older run created before selected-role tracking, repair safe derived state with:

```bash
node ai/tasks/feature/runs.js reconcile
```

The live renderer is also defensive: if an old state file still says `analysis in_progress` while all tracked specialists are terminal and the plan has already started, it renders the effective state and shows a reconciliation warning instead of getting stuck on the stale phase.

Humans can view the live state with:

```bash
npm run workflow:progress:watch
```

Do not commit `ai/runs/`; the dashboard reads those ignored local artifacts and only the optional GitHub PR progress publisher exposes a safe status summary.

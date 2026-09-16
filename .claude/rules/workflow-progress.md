# Workflow progress rule

For every `/feature` run, `ai/runs/<id>/state.json` is the single source of truth for progress.

Record every phase transition with:

```bash
node ai/tasks/feature/runs.js set <phase> <pending|in_progress|pass|fail|blocked|skipped> [note]
```

For parallel specialist work, also record each role independently so the live dashboard can show real progress instead of only `analysis in_progress` or `reviews in_progress`:

```bash
node ai/tasks/feature/runs.js set-role analysis <role> in_progress <executor> [note]
node ai/tasks/feature/runs.js set-role analysis <role> pass <executor> [note]

node ai/tasks/feature/runs.js set-role reviews <role> in_progress <executor> [note]
node ai/tasks/feature/runs.js set-role reviews <role> pass <executor> [note]
```

Use the routed executor name (`claude`, `codex`, or a future provider) in the executor field. On failure/block/skip, record that exact status. Do not mark a role `pass` merely because an agent said it finished; require its expected artifact/evidence.

Recommended sequence for specialist analysis:

1. set `analysis` → `in_progress`;
2. for each selected role, set the role → `in_progress` immediately before delegation;
3. set the role → `pass|fail|blocked|skipped` after evidence is written;
4. set `analysis` → `pass` only when every selected role has a terminal status and required analysis artifacts exist.

Do the same for `reviews`.

Humans can view the live state with:

```bash
npm run workflow:progress:watch
```

Do not commit `ai/runs/`; the dashboard reads those ignored local artifacts and only the optional GitHub PR progress publisher exposes a safe status summary.

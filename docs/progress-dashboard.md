# Progress dashboard

Live terminal GUI for `/feature` runs, plus the commands for working with several features at once.

```bash
agentic progress              # dashboard, focused on the active feature
agentic dashboard             # same view, explicit command
agentic dashboard --all       # include finished runs
agentic runs                  # plain list of in-progress features
agentic runs --all --json     # every run, machine-readable
agentic switch FEAT-002       # make a feature the active run
```

## Layout

The left pane lists features, the right pane shows the highlighted run's stages and specialist roles. Both refresh every second.

```text
╭ AGENTIC · my-app ───────────────────────────────── 3 in progress ╮
├────────────────────┬─────────────────────────────────────────────┤
│ ▸ FEAT-002 *  43%  │ FEAT-002 · Payments retry on timeout        │
│   FEAT-007    12%  │ ██████████░░░░░░░░░░░░░░  43%               │
│   FEAT-011 ✓ 100%  │ 🔒 plan gate: waiting for human approval    │
│                    │ 🔄 Specialist Analysis      in_progress     │
│                    │    🔄 security             in_progress      │
│                    │ Current: Specialist Analysis → security     │
╰────────────────────┴─────────────────────────────────────────────╯
```

| Marker | Meaning |
|---|---|
| `▸` | highlighted (what the right pane shows) |
| `*` | the active run — `agentic resume`, `approve`, `progress` default to it |
| `✓` | finished run (only visible with `--all` or `a`) |

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` / `tab` | move between features (wraps) |
| `enter` / `space` | make the highlighted feature the active run |
| `a` | toggle finished runs |
| `r` | refresh now |
| `home` / `end` | first / last feature |
| `q` / `esc` / `ctrl-c` | quit |

Selecting is the only thing that writes: `enter` updates the `_active` pointer in the state directory. Highlighting alone changes nothing.

## Which run opens

1. an explicit `--run <id>`;
2. otherwise the active run;
3. otherwise the most recently updated in-progress feature.

In-progress features sort first, most recently updated first. A run counts as in progress until it is closed (`state.json` `status: done`).

## Detail compaction

The right pane fits whatever the terminal gives it, dropping the least useful information first: all stages with all roles → roles only for running or stuck stages → those stages alone → stages that have started. A terminal narrower than 78 columns stacks the list above the detail instead of splitting.

## Non-interactive use

Without a TTY — piped, redirected, or in CI — the dashboard prints one frame and exits, so `agentic progress | less` and log capture behave. Scripts should prefer:

```bash
agentic runs --json           # every run with percent, current stage, active flag
agentic progress <id> --json  # one run in detail
```

`--demo` renders sample features without touching the state directory, for a screenshot or a quick look at the layout.

## Where state comes from

Runs live in the state root: `.agentic-runs/` in a target project, `ai/runs/` inside the runtime repository. Each run directory holds `state.json` (stages, roles, evidence), optional `00-request.md` (the title shown next to the id) and `plan.approved` (the plan gate). The dashboard only reads these; the workflow engine owns them.

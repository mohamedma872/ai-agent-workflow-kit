# Guard failure behavior

The runtime separates normal policy decisions from failures inside the guard implementation.

`ai/guard/engine.js` evaluates the normal policy. The configured Claude/Codex hook calls `ai/guard/runner.js`, which supervises that engine. If the engine reports an internal exception, a task-pack rule exception, exits non-zero, or cannot be evaluated safely, the supervisor classifies the pending tool call.

## Failure policy

| Pending operation | Guard-engine failure behavior |
|---|---|
| Product file write/edit/patch | **deny** |
| Secret-file read | **deny** |
| Mutating/destructive/unknown shell command | **deny** |
| External MCP write/unknown MCP call | **deny** |
| Clearly read-only source read | allow by default |
| Clearly read-only shell diagnostic (`git status`, `git diff`, `ls`, `grep`, etc.) | allow by default |
| Clearly read-only MCP lookup | allow by default |

The denial reason starts with `guard-engine failure:` so it is distinguishable from a normal policy denial.

For environments that require the strongest posture, set:

```bash
AI_GUARD_FAIL_OPEN_READ_ONLY=0
```

Then even clearly read-only operations fail closed while the guard is unhealthy.

## Plan-gate shell write coverage

Before human plan approval, the feature guard detects direct and indirect repository writes including:

- shell redirects (`>`, `>>`) and `tee`;
- `sed -i`, Perl in-place edits;
- `cp`, `mv`, `touch`, `rm`, `mkdir`, `install`, `dd`, `patch`;
- Python `open(..., write-mode)`, pathlib writes, `shutil.copy/move`, and common `os.*` mutations;
- Node `writeFile*`, `appendFile*`, `copyFile*`, `rename*`, `unlink*`, `rm*`, `mkdir*`;
- Ruby `File.write/open/rename/delete` and `IO.write`.

Writes that are clearly scoped only to `ai/runs/` are allowed so the workflow can build its planning/evidence artifacts before approval. A command that mixes a product path with an `ai/runs/` path is denied.

The detector intentionally errs on the side of denying an ambiguous mutating command while the plan gate is closed. Read-only commands such as `cat`, `grep`, `git status`, and `git diff` are covered by regression tests to keep false positives low.

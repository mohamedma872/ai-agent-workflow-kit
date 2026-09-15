---
description: Show the guardrails that are active right now — validates the YAML rule files, prints every rule in words, which agents are wired, and the status of any active /feature run. Usage — /fence
---

Run these and report the output verbatim under three headings, then one line
of interpretation each (anything invalid, anything not wired, any active run
with a closed plan gate):

!`node ai/guard/engine.js --check`

!`node ai/guard/engine.js --explain`

!`node ai/tasks/feature/runs.js status`

Do not change any rule file: `ai/guard.yaml` and the task `guard.yaml` files are edited only by the user.

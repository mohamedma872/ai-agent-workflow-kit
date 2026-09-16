# Current documentation rule — use Context7 when external APIs can drift

Use the `docs-researcher` subagent (Context7) before making a plan or code decision that depends on a third-party library/framework/SDK API, version-specific setup, migration, deprecation, build configuration, or behavior that may have changed since model training.

Do not use a documentation lookup when the answer is already proven by this repository's own source code.

For `/feature` runs:

- When the task depends on an external library or SDK, run the `docs` role from `ai/workflows/feature.yaml` during analysis and save the result to `ai/runs/<id>/05-analysis/docs-researcher.md`.
- Detect the dependency version from the repository before querying Context7.
- Prefer exact library IDs and version-specific queries.
- Keep the documentation artifact focused: relevant current behavior, impact on the task, and uncertainty/version mismatch.
- Include the relevant decisions from `05-analysis/docs-researcher.md` in the approved implementation/fixes context passed to Codex. Do not send large documentation dumps through the orchestrator context.
- Reuse an existing docs artifact when it already answers the same version-specific question; do not re-query just to repeat the same context.

If Context7 is unavailable or has no documentation for the needed version, say so explicitly and do not invent the API. Use the project's local source/types/tests as the next source of truth.

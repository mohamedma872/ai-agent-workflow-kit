---
name: current-docs
description: Resolve current, version-specific external library/framework/SDK documentation with Context7 and turn it into a compact decision artifact. Use for migrations, upgrades, deprecated APIs, setup/configuration, unfamiliar packages, and version-sensitive implementation/review questions.
---

Use this skill when a coding decision depends on documentation outside the repository and that documentation may have changed.

## Inputs

`$ARGUMENTS` should name the library/framework/SDK plus the question. If a `/feature` run is active, also use the request, acceptance criteria, and inspection artifact as context.

## Procedure

1. Detect the version actually used by the repository from the nearest authoritative manifest/lock/config file.
2. Delegate the lookup to `docs-researcher` so documentation calls stay out of the main orchestration context.
3. The researcher must use Context7, prefer the exact library ID when known, and include the detected version in the query.
4. Compare the retrieved documentation with local source/types/tests when they disagree. Local code proves what this repository currently does; current docs prove what the external API currently specifies.
5. Return only the decision-relevant facts. Never paste a large documentation page into the orchestration context.
6. In a `/feature` run, save the report to `ai/runs/<id>/05-analysis/docs-researcher.md` and reference that artifact from the plan and any Codex implementation/fixes context.

## Output

```text
# Current docs — <topic>
Repository version: <version or unknown>
Context7 source: <library id / version>

## Current behavior
- ...

## Decision for this task
- ...

## Uncertainty
- none | ...
```

If Context7 is unavailable or lacks the required version, state that explicitly. Do not fill the gap from memory as if it were verified current documentation.

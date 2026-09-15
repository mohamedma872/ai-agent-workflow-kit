---
description: Plan a feature or ticket without implementing — requirements, acceptance criteria, definition of done, repo inspection, specialist analyses, and the implementation plan for review. Usage — /plan <request or PROJ-123>
---

Run the `feature` skill in plan-only mode: `/feature $ARGUMENTS plan-only`.

Deliver the plan from `ai/runs/<id>/06-plan.md` in the reply, with the run id,
so the user can later continue with `/feature <same id>` after approving with
`node ai/tasks/feature/runs.js approve <id>`. Change no product file.

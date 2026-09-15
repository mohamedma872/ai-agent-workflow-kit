---
description: Fix a Jira ticket end-to-end through the delivery workflow (requirements → AC → DoD → analyses → plan approval → implementation → tests → reviews → verification). Usage — /fix-issue PROJ-123
---

Ticket: $ARGUMENTS

1. Fetch it with `mcp__jira__jira_get_issue` (summary, description,
   acceptance criteria, comments count, links). If it is not a bug or a
   change request, say what it is and ask whether to continue.
2. Reproduce first: find the code path, and where possible write the failing
   unit test before any fix (that test is the first acceptance criterion).
3. Hand over to the workflow: run the `feature` skill with
   `/feature $ARGUMENTS`. The plan gate applies — no product edits before the
   plan is approved.
4. When the workflow's verification is done, prepare the Jira update as a
   draft comment (what changed, how it was verified, which build) and ask
   before posting — Jira writes always ask.

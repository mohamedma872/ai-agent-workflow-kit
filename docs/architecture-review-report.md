# Architecture review export

Runtime 1.9.19 adds a normalized architecture review export for any workflow run.

```bash
agentic architecture-report FEAT-001
agentic architecture-report FEAT-001 --json
agentic architecture-report FEAT-001 --output ./review-export
```

By default the command writes:

```text
.agentic-runs/<run-id>/reports/
├── architecture-review.md
└── architecture-review.json
```

The report aggregates the run's synthesized analysis findings plus independent review findings. It never turns a missing review into a pass.

## Required architecture coverage

The architecture specialist must explicitly cover every area below for new runs:

1. Feature Boundaries & Dependency Management
2. Domain & Business Rules
3. Data & State Management
4. Concurrency & Synchronization
5. API & Error Handling
6. Navigation
7. Security & Privacy
8. Observability
9. Performance & Scalability
10. Testing & Quality
11. Architecture Enforcement
12. Maintainability
13. E-Commerce Architecture — mark `not-applicable` when the repository/request is not commerce-related.

Each coverage entry records `pass`, `finding`, `not-applicable`, or `not-reviewed`, plus evidence. A missing area is a coverage gap, not a clean result.

## Finding contract

Architecture findings should include:

```text
group
severity
issue/title
currentDesign
evidence
recommendation
why
impact
priority (P0/P1/P2)
ownerDomain
confidence
principle
```

The exported Markdown groups findings by concern and shows all of those fields in one table.

## Decision semantics

The report's decision is advisory:

- **BLOCKED** — a specialist artifact is blocked, a critical unresolved finding exists, or an independent review has an unresolved critical/high finding.
- **CONDITIONAL** — unresolved high/medium findings remain.
- **PASS** — no blocking/conditional finding remains.

Deterministic workflow gates and explicit human approvals still own progression.

## Why this exists

The report answers two separate questions:

1. **What did reviewers find?**
2. **What did the workflow actually inspect?**

Without the coverage matrix, "no finding" can be confused with "not reviewed". The export keeps those states distinct.

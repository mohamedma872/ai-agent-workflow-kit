# Architecture review export

The canonical architecture/review rules are maintained in one place:

```text
ai/standards/engineering-rulebook.md
```

See that rulebook for:

- Clean Code
- SOLID
- Clean Architecture
- data/state/concurrency/error rules
- Fowler-style refactoring
- testing
- security/observability/performance
- navigation
- e-commerce rules
- all 13 mandatory architecture coverage areas
- finding fields
- severity and priority
- PASS / CONDITIONAL / BLOCKED semantics
- ADR rules
- architecture fitness functions
- architecture Definition of Done

This document only describes how to export the report.

## Export

```bash
agentic architecture-report FEAT-001
agentic architecture-report FEAT-001 --json
agentic architecture-report FEAT-001 --output ./review-export
```

By default:

```text
.agentic-runs/<run-id>/reports/
├── architecture-review.md
└── architecture-review.json
```

The export aggregates synthesized specialist findings and independent review findings.

The report never treats missing coverage as a pass. The exact coverage and decision rules are defined in the canonical rulebook.

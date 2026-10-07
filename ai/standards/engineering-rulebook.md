# Engineering Rulebook

This is the **single canonical engineering rulebook** for the Agentic Workflow Runtime.

It consolidates architecture, clean-code, refactoring, review, testing, concurrency, e-commerce, and reporting rules that were previously spread across agent prompts and supporting docs.

These are paraphrased engineering principles, not reproduced book text.

Primary influences:

- Robert C. Martin — *Clean Code*
- Robert C. Martin — *Clean Architecture*
- Martin Fowler — *Refactoring*
- Martin Fowler — *Patterns of Enterprise Application Architecture*

Repository evidence, explicit product constraints, measured behavior, approved ADRs, and human architecture decisions take precedence over generic guidance when they intentionally differ.

---

## 1. Core review principles

Every material finding must answer:

- **WHAT** — what is wrong or risky?
- **EVIDENCE** — where is it proven? File/line, dependency, runtime behavior, test, command, or artifact.
- **WHY** — why is it an engineering problem?
- **IMPACT** — what does it affect: correctness, security, maintainability, performance, testability, scalability, delivery, or user experience?
- **HOW** — what precise change is recommended?
- **PRIORITY** — P0 / P1 / P2 based on risk.
- **PRINCIPLE** — which rule in this rulebook or approved project-specific rule applies?
- **EXCEPTION** — is the current design intentionally justified by an ADR, migration constraint, framework limitation, or explicit trade-off?

Rules:

- No evidence means no finding.
- No finding does **not** mean an area was reviewed.
- A style preference must never become a Critical/High finding.
- Code smells are investigation signals, not automatic defects.
- Do not require a pattern merely because a book recommends it.
- Prefer the smallest evidence-backed correction over a broad rewrite.
- Approved ADRs and explicit constraints can justify deviations.
- Architecture is about dependency direction and ownership, not folder names alone.

---

## 2. Severity and priority

### Critical / P0

Use for:

- data loss or corruption;
- security exposure;
- broken correctness in a critical path;
- unsafe payment/order behavior;
- systemic architecture violation creating immediate high-risk coupling;
- unsafe migration or synchronization behavior.

### High / P1

Use for:

- substantial reliability risk;
- strong coupling likely to block upcoming work;
- major testability/maintainability problem;
- high scalability/performance risk;
- serious contract or state-management flaw.

### Medium / P1-P2

Use for meaningful design debt with bounded impact.

### Low / P2

Use for local improvements with limited risk.

### Info

Use for observations or optional improvements.

---

# PART A — CLEAN CODE

## 3. Naming and readability

- Names must reveal intent, domain meaning, and units when relevant.
- Use one consistent term for one concept.
- Prefer searchable and pronounceable names.
- Avoid misleading names.
- Avoid unexplained abbreviations.
- Public APIs should be more explicit than private implementation details.
- Code should be understandable without comments explaining ordinary control flow.
- Domain language should match product/business terminology.

Raise a finding only when naming hides behavior, ownership, units, lifecycle, side effects, or domain meaning.

---

## 4. Functions and methods

- A function should have one coherent responsibility.
- Keep one level of abstraction where practical.
- Avoid functions that validate, fetch, persist, navigate, log, mutate state, and render all at once.
- Prefer small composable operations when extraction improves meaning or testability.
- Minimize arguments.
- Use a parameter/value object when several arguments form one concept.
- Avoid boolean/flag parameters that make one function perform unrelated modes.
- Make side effects explicit.
- Separate queries from commands where practical.
- Prefer guard clauses when they reduce deeply nested control flow.
- Do not enforce arbitrary line-count limits.
- Complexity and mixed responsibilities matter more than function length.

---

## 5. Classes and modules

- A class/module should have a cohesive reason to change.
- Avoid god classes/modules.
- Separate business policy from framework, UI, persistence, transport, and platform code.
- Prefer composition over inheritance when behavior can be assembled from collaborators.
- Expose the smallest useful interface.
- Avoid pass-through wrappers with no policy.
- Avoid speculative abstractions.
- Remove dead code and obsolete compatibility paths after migration exit criteria are met.

---

## 6. Comments and documentation

- Comments should explain **why**, constraints, trade-offs, non-obvious risk, or external requirements.
- Do not use comments to compensate for confusing code when refactoring can make the code clear.
- Remove stale or misleading comments.
- Remove commented-out code.
- Architectural exceptions should have an ADR or equivalent documented decision.
- Temporary migration logic needs removal criteria.
- Documentation must reflect the actual implementation.

---

# PART B — SOLID

## 7. Single Responsibility Principle — SRP

- Group behavior that changes for the same reason.
- Separate behavior owned by different actors/policies.
- A module that mixes unrelated business rules, persistence, analytics, UI, and navigation likely violates SRP.

Do not split code mechanically; cohesion is the goal.

---

## 8. Open/Closed Principle — OCP

- Prefer stable extension points for credible expected variation.
- Avoid repeatedly modifying central conditionals when variation is already recurring.
- Do not introduce abstraction before variation is credible.
- Do not create plug-in architectures for hypothetical future requirements.

---

## 9. Liskov Substitution Principle — LSP

Implementations/subtypes must preserve the abstraction's behavioral contract:

- accepted inputs;
- outputs;
- invariants;
- side effects;
- error semantics;
- ordering/lifecycle expectations.

An implementation that narrows valid input, changes failure semantics, or violates invariants is not safely substitutable.

---

## 10. Interface Segregation Principle — ISP

- Prefer focused interfaces shaped around consumer needs.
- Consumers should not depend on unrelated methods.
- Avoid broad service/repository interfaces that accumulate unrelated responsibilities.

---

## 11. Dependency Inversion Principle — DIP

- High-level policy should depend on abstractions, not infrastructure details.
- Inner layers should own/control abstractions required by policy.
- Infrastructure implements those abstractions.
- Do not leak HTTP clients, databases, storage SDKs, routing frameworks, or platform APIs into business policy.

---

# PART C — CLEAN ARCHITECTURE

## 12. Dependency direction

Dependencies should point toward stable business policy.

Expected direction:

```text
App / Composition
       │
       ├───────────────┐
       ▼               ▼
Presentation       Data / Infrastructure
       │               │
       └──────► Domain ◄┘
```

Rules:

- Domain does not depend on Presentation.
- Domain does not depend on Data.
- Domain does not depend on framework APIs.
- Presentation may invoke Domain/Application behavior.
- Data implements contracts needed by Domain/Application.
- App/composition layer may wire all layers together.

---

## 13. Domain purity

Domain/business policy must not depend on:

- Flutter/React/Android/iOS UI APIs;
- Bloc/Redux/router framework APIs;
- Dio/Retrofit/HTTP clients;
- database or persistence SDKs;
- JSON transport models;
- platform APIs;
- concrete analytics/crash SDKs.

Approved pure-language/value libraries may be used if the project policy allows them.

---

## 14. Application/use-case layer

- Coordinates business behavior.
- Does not become another infrastructure layer.
- Should not know HTTP/database/framework details.
- Use cases should exist when they add orchestration, policy, reuse, or boundary value.
- Do not create one-line use cases mechanically if they add no value.

---

## 15. Data/infrastructure layer

- Implements contracts required by inner policy.
- Owns DTOs, persistence models, API payloads, database mappings, SDK adapters.
- Maps boundary models to domain/application models.
- Does not leak infrastructure exceptions everywhere.
- Converts low-level failures into stable application/domain-relevant outcomes.

---

## 16. Presentation layer

- Owns rendering and user interaction.
- Invokes application/domain behavior.
- Does not directly coordinate persistence or HTTP infrastructure.
- UI state should model user-visible states explicitly.
- Navigation decisions should respect route ownership and application policy.

---

## 17. Composition root and dependency injection

- Object creation/wiring belongs in an explicit composition root.
- Dependency injection configuration must not leak into Domain.
- Keep environment-specific implementations replaceable.
- Construction ownership should be obvious.

---

## 18. Core/shared ownership

- Shared/core must contain genuinely reusable technical capabilities.
- Core must not depend on features.
- Core must not become a hidden business module.
- Feature-specific business logic stays inside its feature/domain.
- Avoid dumping miscellaneous helpers into Core.

---

## 19. Feature boundaries

- One feature must not import another feature's private Data layer.
- One feature must not import another feature's private Presentation layer.
- Cross-feature orchestration should use:
  - app/composition layer;
  - explicit public contract;
  - domain/application event/contract where justified.
- Direct BLoC/ViewModel/controller imports across features are a coupling warning.
- Feature-first folders are not enough; the dependency graph must remain modular.

---

## 20. Boundary mapping

Do not leak across architectural boundaries:

- API DTOs;
- persistence entities;
- database rows;
- SDK objects;
- UI framework objects.

Map them explicitly when leakage would couple policy to infrastructure.

Avoid mapping layers when they add no useful boundary protection.

---

# PART D — DATA, STATE, CONCURRENCY, ERRORS

## 21. Source of truth

- Define one authoritative owner for each important state.
- Avoid multiple layers believing they own the same mutable state.
- Distinguish:
  - UI state;
  - local/cache state;
  - server-authoritative state;
  - final business authority.

For commerce, backend validation is authoritative for final price, inventory, promotion, tax, shipping, payment, and order creation.

---

## 22. Persistence and offline behavior

- User-visible durable state should be persisted before delayed noncritical synchronization when process death would otherwise lose it.
- Local cache must not silently become final business authority.
- Define offline/reconnect behavior explicitly.
- Mark pending synchronization explicitly when appropriate.
- Technical sync failure should not automatically erase valid local user intent.

---

## 23. Concurrency

Review:

- race conditions;
- request ordering;
- stale responses;
- cancellation;
- retries;
- deduplication;
- debounce;
- throttle;
- per-key/per-entity synchronization;
- queue ordering;
- lifecycle races.

Rules:

- Async ordering is a correctness concern.
- Stale responses must not overwrite newer state.
- Debounce/throttle are not only performance techniques; they change behavior.
- Use per-entity synchronization when global debounce would couple unrelated actions.

---

## 24. Idempotency and retries

- Retried operations should be idempotent where possible.
- Prefer absolute commands such as `setQuantity(productId, 3)` over ambiguous repeated deltas where retry can duplicate effects.
- Consider duplicate network delivery.
- Consider partial completion.
- Consider retry after timeout when the server may already have applied the request.
- Payment/order mutations require explicit idempotency strategy.

---

## 25. Error handling

- Expected failures should be explicit.
- Distinguish technical failures from business-rule rejection.
- Avoid using exceptions as ordinary control flow when a result type is clearer.
- Preserve diagnostic context without exposing secrets/PII.
- Do not silently swallow failures unless behavior is explicitly best-effort and observable.
- Avoid generic "server error" handling when UX/business behavior differs by failure.

Typical technical failures:

- connectivity;
- timeout;
- authentication;
- authorization;
- rate limit;
- server;
- cache/storage;
- serialization;
- unknown.

Typical business failures:

- out of stock;
- quantity limit;
- invalid promotion;
- product unavailable;
- cart/version conflict;
- payment rejected.

---

# PART E — REFACTORING

## 26. Fowler-style refactoring discipline

- Refactor in small behavior-preserving steps.
- Establish sufficient tests/evidence before structural changes.
- Separate refactoring from unrelated feature work when practical.
- Re-run relevant verification after meaningful increments.
- Keep rollback points for risky migrations.
- Preserve observable behavior unless an intentional change is approved.
- Measure before optimizing performance.

Common safe transformations include:

- rename;
- extract function;
- extract class/module;
- inline;
- move function/field;
- encapsulate variable;
- introduce parameter object;
- split phase;
- replace duplicated conditional knowledge with an appropriate abstraction.

---

## 27. Code smells to investigate

These are signals, not automatic violations:

- duplicated logic;
- duplicated business decisions;
- long function with mixed abstraction levels;
- large class/module;
- long parameter list;
- primitive obsession;
- data clumps;
- feature envy;
- shotgun surgery;
- divergent change;
- deep conditional trees;
- message chains;
- middle-man/pass-through layers;
- speculative generality;
- temporary fields / partially valid objects;
- dead code;
- obsolete migration paths.

A smell becomes a finding only when there is concrete impact.

---

# PART F — SIMPLICITY AND DESIGN RESTRAINT

## 28. Avoid over-engineering

Prefer the simplest design satisfying:

- current requirements;
- explicit quality attributes;
- credible near-term variation.

Do not add by default:

- repository;
- use case;
- interface;
- factory;
- adapter;
- base class;
- generic framework;
- event bus.

An abstraction should earn its cost through at least one of:

- boundary protection;
- independent variation;
- testability;
- reuse;
- domain clarity;
- replaceability;
- security/reliability policy.

---

## 29. Patterns

- Patterns are tools, not goals.
- Apply a pattern only when the problem exists.
- Prefer repository conventions unless they are demonstrably harmful.
- Do not rewrite stable code solely to match a preferred textbook pattern.
- When introducing a pattern, explain the concrete problem it solves.

---

# PART G — TESTING AND QUALITY

## 30. Testing principles

- Test observable behavior and business rules.
- Avoid over-testing incidental implementation details.
- Keep tests deterministic.
- Tests must not depend on execution order.
- Put business-policy tests close to policy.
- Test real boundaries where mapping/serialization/persistence/network/framework behavior matters.
- Do not weaken tests to make a change pass.
- Refactors require behavior-preservation evidence.

---

## 31. Recommended test layers

Use as applicable:

- Domain unit tests.
- Use-case/application tests.
- Repository tests.
- Data-source integration tests.
- State/BLoC/ViewModel/controller transition tests.
- Widget/component/UI tests.
- Navigation/deep-link tests.
- API contract tests.
- Persistence migration tests.
- E2E tests.
- Device tests.
- Performance/load tests.
- Security tests.

---

## 32. Negative and edge cases

Review/test:

- empty state;
- loading;
- partial data;
- timeout;
- offline;
- reconnect;
- unauthorized;
- forbidden;
- rate limiting;
- cancellation;
- rapid repeated input;
- retries;
- duplicate delivery;
- stale response;
- process death/restart;
- configuration/environment mismatch;
- invalid deep links;
- unavailable dependencies.

---

# PART H — SECURITY, OBSERVABILITY, PERFORMANCE

## 33. Security and privacy

Review:

- authentication/session handling;
- token lifecycle;
- secure storage;
- secrets;
- transport security;
- input validation;
- authorization;
- deep links;
- WebViews;
- permissions;
- logging;
- PII;
- payment/business-sensitive data.

Never log:

- passwords;
- access/refresh tokens;
- authorization headers;
- payment secrets/card data;
- private keys;
- sensitive PII unless explicitly approved and protected.

---

## 34. Observability

- Production logging should be structured and sanitized.
- Development verbosity must not automatically ship to production.
- Add metrics/tracing where they answer real operational questions.
- Failures should be diagnosable without exposing sensitive data.
- Important background/retry/synchronization failures should be observable.

---

## 35. Performance

Review:

- startup;
- rendering/rebuilds;
- list virtualization;
- pagination;
- memory;
- CPU;
- image loading/caching;
- networking;
- serialization;
- database access;
- concurrency;
- bundle/build size;
- background work.

Rules:

- Measure before micro-optimizing.
- Optimize identified hot paths.
- Do not add architecture complexity based on hypothetical performance gains.

---

# PART I — NAVIGATION

## 36. Navigation rules

- Route ownership should be explicit.
- Prefer typed route arguments over generic maps where supported.
- Centralize global routing policy.
- Deep links and push notifications should resolve through the same route contracts where possible.
- Feature A should not navigate by importing Feature B's internal screen implementation.
- Authentication/authorization guards must be testable.
- Dual navigation stacks during migration require:
  - ADR;
  - rollback strategy;
  - success criteria;
  - removal criteria.

---

# PART J — E-COMMERCE

## 37. Catalog

- Define product/catalog source of truth.
- Cache policy must be explicit.
- Handle stale product details.
- Image loading must be scalable.
- Pagination must handle duplicate/missing/reordered results safely.

---

## 38. Cart

- Local cart mutation should be immediately durable when users expect persistence.
- Debounce remote synchronization, not critical local durability.
- Network failure should usually retain local user intent and mark pending sync.
- Business rejection may reconcile/rollback with clear UX.
- Synchronize per product/entity when required.
- Prefer idempotent quantity commands.
- Cart state should represent synchronization/reconciliation when necessary.

---

## 39. Checkout

Backend must be authoritative for:

- inventory;
- current price;
- discounts;
- promotions;
- tax;
- shipping;
- eligibility;
- final total;
- payment acceptance;
- order creation.

The client may display cached/estimated values but must not be final commercial authority.

---

## 40. Payment and orders

- Use idempotency for order/payment mutation where duplicate submission is possible.
- Protect against double taps and retry duplication.
- Define timeout ambiguity handling.
- Do not store secrets/payment credentials insecurely.
- Ensure order confirmation is derived from authoritative backend state.

---

## 41. Force update

For high-scale apps:

- distinguish optional vs mandatory update;
- define minimum supported version;
- support staged rollout;
- avoid update loops;
- handle store propagation delay;
- make remote configuration failure-safe;
- test kill-switch behavior;
- avoid blocking users unless compatibility/security requires it.

---

## 42. Environment consistency

Validate parity across:

- development/sprint;
- UAT;
- production.

Check:

- API base URLs;
- feature flags;
- auth configuration;
- certificates/pinning;
- remote config;
- analytics;
- push configuration;
- payment configuration;
- deep links;
- environment-specific capabilities.

---

# PART K — ARCHITECTURE REVIEW COVERAGE

## 43. Mandatory coverage areas

Every Architecture Agent run must explicitly review all areas below.

1. **Feature Boundaries & Dependency Management**
   - dependency direction;
   - cross-feature imports;
   - composition root;
   - DI;
   - shared/core ownership.

2. **Domain & Business Rules**
   - domain purity;
   - invariants;
   - business authority;
   - domain models;
   - business failures.

3. **Data & State Management**
   - repositories;
   - local/remote ownership;
   - persistence;
   - cache;
   - offline behavior;
   - state model;
   - source of truth.

4. **Concurrency & Synchronization**
   - race conditions;
   - retry;
   - debounce/throttle;
   - cancellation;
   - idempotency;
   - stale responses;
   - conflict resolution.

5. **API & Error Handling**
   - API contracts;
   - result model;
   - failure taxonomy;
   - timeout/retry;
   - technical vs business errors;
   - backward compatibility.

6. **Navigation**
   - route ownership;
   - typed args;
   - deep links;
   - guards;
   - navigation coupling;
   - migration switches.

7. **Security & Privacy**
   - auth;
   - storage;
   - secrets;
   - PII;
   - network;
   - input validation;
   - permissions.

8. **Observability**
   - logging;
   - crash reporting;
   - metrics;
   - traces;
   - sanitization;
   - production diagnostics.

9. **Performance & Scalability**
   - rendering;
   - startup;
   - memory;
   - network;
   - images;
   - pagination;
   - user/load scale.

10. **Testing & Quality**
    - unit;
    - state;
    - widget/UI;
    - integration;
    - E2E;
    - contract;
    - regression;
    - device coverage.

11. **Architecture Enforcement**
    - lints;
    - import boundaries;
    - architecture tests;
    - fitness functions;
    - ADR compliance;
    - dependency checks.

12. **Maintainability**
    - naming;
    - structure;
    - complexity;
    - duplication;
    - generated code;
    - documentation;
    - dead code.

13. **E-Commerce Architecture**
    - catalog;
    - cart;
    - inventory;
    - pricing;
    - promotions;
    - checkout;
    - payment;
    - order idempotency;
    - offline/reconnect;
    - force update;
    - environment/API consistency.

For non-commerce products, #13 must be explicitly `not-applicable`.

---

## 44. Coverage states

Each area must be one of:

- `pass` — explicitly reviewed with evidence and no material finding.
- `finding` — explicitly reviewed and one or more findings exist.
- `not-applicable` — explicitly irrelevant, with reason.
- `not-reviewed` — insufficient evidence to claim review.

Rule:

```text
No finding ≠ Pass
```

Missing coverage must be reported as a gap.

---

# PART L — FINDING AND REPORT CONTRACT

## 45. Architecture finding fields

Every architecture finding should provide:

```text
id
group
severity
issue/title
currentDesign
evidence
recommendation
why
impact
priority
ownerDomain
confidence
uncertainty
principle
conflictsWith (when applicable)
```

---

## 46. Architecture report groups

Reports group findings under:

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
13. E-Commerce Architecture

---

## 47. Architecture report sections

A complete report should contain:

- Executive Summary
- Architecture Strengths
- Coverage Matrix
- Key Architecture Issues
- P0 — Must Fix
- P1 — Should Fix Early
- P2 — Improvements
- Architecture/Dependency View where useful
- Required ADRs
- Recommended target architecture where relevant
- Migration/remediation plan where relevant
- Definition of Done implications
- Coverage gaps
- Final Decision

---

## 48. Architecture decision semantics

Advisory report decision:

### BLOCKED

Use when:

- a specialist is blocked;
- a Critical unresolved finding exists;
- an independent review has an unresolved Critical/High finding.

### CONDITIONAL

Use when unresolved High/Medium concerns remain.

### PASS

Use when no blocking/conditional finding remains.

The report verdict does not replace deterministic workflow gates or human architecture approval.

---

# PART M — ARCHITECTURE DECISIONS

## 49. ADR rules

Create an ADR when a decision is:

- hard to reverse;
- cross-cutting;
- introduces a new architectural pattern;
- changes dependency direction;
- introduces a major framework/library;
- creates a temporary migration architecture;
- affects security/reliability guarantees;
- materially changes ownership boundaries.

An ADR should include:

- context;
- decision;
- alternatives considered;
- consequences;
- trade-offs;
- migration/rollback where applicable;
- review/removal date for temporary decisions.

---

## 50. Architecture fitness functions

Important architectural rules should be enforceable when practical.

Examples:

- Domain cannot import framework packages.
- Feature A cannot import Feature B Data/Presentation.
- Core cannot import Features.
- prohibited dependencies fail CI;
- architecture tests validate module boundaries;
- lint rules validate forbidden imports.

Documentation without enforcement should not be the only protection for critical boundaries.

---

# PART N — DEFINITION OF DONE FOR ARCHITECTURE

## 51. Architecture review is complete only when

- all 13 coverage areas are explicitly classified;
- every pass has evidence;
- every finding has evidence;
- Critical/High findings have a concrete recommendation;
- WHY and IMPACT are present;
- cross-feature dependencies are checked;
- state/source-of-truth ownership is checked;
- error/retry/idempotency semantics are checked;
- security/privacy logging is checked;
- testing strategy is checked;
- architecture enforcement is checked;
- ADR needs are identified;
- known gaps are explicit;
- report decision is generated without turning missing review into pass.

---

# PART O — RULE PRIORITY

## 52. When rules conflict

Use this precedence:

```text
Safety / Security / Data Integrity
            ↓
Explicit Business Requirement
            ↓
Approved Architecture Decision / ADR
            ↓
Measured Runtime Evidence
            ↓
Repository-Specific Established Convention
            ↓
This Engineering Rulebook
            ↓
Personal Style Preference
```

A lower-level rule must not override a higher-level constraint without explicit human approval.

---

## 53. Final restraint

The purpose of these rules is to improve:

- correctness;
- maintainability;
- testability;
- security;
- performance;
- scalability;
- delivery safety;
- architecture clarity.

They are not intended to maximize abstraction, file count, pattern count, or architectural ceremony.

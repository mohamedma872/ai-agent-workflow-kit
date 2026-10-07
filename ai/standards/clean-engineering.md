# Clean Engineering Standards

These are **paraphrased engineering principles**, not reproduced book text.

Primary influences:

- Robert C. Martin — *Clean Code*
- Robert C. Martin — *Clean Architecture*
- Martin Fowler — *Refactoring*
- Martin Fowler — *Patterns of Enterprise Application Architecture*

Use these principles as review heuristics, not as dogma. Repository-specific architecture decisions, explicit product constraints, measurable evidence, and approved ADRs take precedence when they intentionally differ.

## 1. Naming and readability

- Choose names that reveal intent, domain meaning, and units where relevant.
- Use one consistent term for one concept. Do not alternate between synonyms for the same domain idea.
- Prefer searchable, pronounceable names over abbreviations or encodings.
- Avoid misleading names and names whose type/meaning contradicts their behavior.
- Keep public APIs more explicit than private implementation details.
- Code should be understandable without requiring comments to explain ordinary control flow.

### Review signal

Raise a finding when naming materially hides behavior, ownership, units, lifecycle, side effects, or business meaning. Do not raise findings for subjective naming preferences alone.

## 2. Functions and methods

- Keep a function focused on one coherent responsibility and one level of abstraction.
- Prefer small, composable operations over functions that parse, validate, persist, navigate, log, mutate state, and render at once.
- Minimize arguments. When several arguments represent one concept, prefer an explicit value object/parameter object.
- Avoid boolean/flag arguments when they cause one function to perform multiple distinct behaviors.
- Make side effects obvious from the API and ownership boundary.
- Separate queries from state-changing commands where practical.
- Prefer early validation/guard clauses when they reduce deeply nested control flow.
- Extract repeated or conceptually distinct logic when doing so improves meaning or testability.

### Review signal

Do not enforce arbitrary line-count limits. Complexity, mixed responsibilities, duplicated decisions, and hidden side effects matter more than raw function length.

## 3. Classes, modules, and responsibilities

- A class/module should have a cohesive reason to change.
- Keep business policy separate from framework, transport, persistence, UI, and platform details.
- Avoid "god" classes/modules that coordinate unrelated responsibilities.
- Prefer composition over inheritance when behavior can be assembled from smaller collaborators.
- Expose the smallest useful interface; consumers should not depend on methods they do not need.
- Avoid unnecessary wrappers, pass-through layers, and speculative abstractions.
- Remove dead code and obsolete compatibility paths once their migration exit criteria are met.

## 4. SOLID principles

### Single Responsibility Principle

A module should group behavior that changes for the same reason and separate behavior owned by different actors or policies.

### Open/Closed Principle

Prefer designs that allow expected variation through stable extension points instead of repeated modification of central conditionals. Do not introduce abstraction before there is credible variation.

### Liskov Substitution Principle

Subtypes/implementations must honor the behavioral expectations of the abstraction: accepted inputs, outputs, invariants, side effects, and error semantics.

### Interface Segregation Principle

Prefer focused interfaces shaped around consumer needs rather than broad contracts that force unrelated dependencies.

### Dependency Inversion Principle

High-level policy should depend on abstractions it owns or controls; infrastructure/framework details implement or plug into those abstractions.

## 5. Clean Architecture boundaries

- Dependencies should point toward stable business policy, not outward toward frameworks and infrastructure.
- Domain/business rules must remain independent of UI frameworks, HTTP clients, databases, persistence libraries, routing libraries, and platform APIs.
- Application/use-case logic coordinates domain behavior; it should not become a second infrastructure layer.
- Data/infrastructure layers implement interfaces needed by inner policy layers.
- Presentation may invoke application/domain behavior but should not directly coordinate persistence or transport details.
- Map DTOs, persistence models, API payloads, and framework objects at boundaries instead of leaking them into the domain.
- Keep dependency injection and object construction in an explicit composition root.
- Shared/core infrastructure must not become a hidden business module or depend back on features.
- Feature A should not directly import Feature B's private Data or Presentation internals. Cross-feature orchestration needs an explicit contract or composition layer.
- Frameworks are replaceable details. Core business rules should be testable without starting the framework/runtime where practical.

## 6. Boundaries and data ownership

- Define one authoritative owner/source of truth for each important state.
- Make transaction and consistency boundaries explicit.
- Avoid two layers believing they both own the same mutable state.
- Keep local/cache state semantics distinct from server-authoritative business state.
- Treat external systems, SDKs, databases, queues, and UI frameworks as boundary concerns.
- Translate boundary failures into application/domain-relevant outcomes rather than leaking transport-specific exceptions everywhere.

## 7. Error handling

- Make expected failure modes explicit and meaningful.
- Distinguish technical failures from business-rule rejection.
- Do not use exceptions as ordinary control flow when an expected result type is clearer.
- Preserve useful diagnostic context without exposing secrets or sensitive user data.
- Do not silently swallow failures unless the behavior is explicitly best-effort and observable.
- Centralize translation of low-level failures when it prevents duplicated error semantics.
- Ensure retries are safe: consider idempotency, duplicate requests, partial completion, and cancellation.

## 8. State, concurrency, and side effects

- Make mutation ownership explicit.
- Avoid hidden shared mutable state.
- Define ordering semantics for asynchronous events where order matters.
- Treat retries, debounce, throttle, cancellation, and deduplication as correctness decisions, not only performance optimizations.
- Prefer idempotent commands for operations that can be retried.
- Persist user-visible durable state before delaying noncritical synchronization when loss on process termination would violate expectations.
- Protect against stale responses overwriting newer state.
- Keep irreversible/external effects behind explicit boundaries.

## 9. Comments and documentation

- Comments should primarily explain **why**, constraints, trade-offs, non-obvious risks, or external requirements.
- Do not use comments to compensate for confusing names or unnecessarily complex code when refactoring can make the code clear.
- Remove stale, misleading, commented-out, or duplicated documentation.
- Record architectural exceptions and migration compromises explicitly, preferably with ADRs and removal criteria.
- Documentation must describe the actual implementation, not an intended architecture that the code no longer follows.

## 10. Testing

- Test observable behavior and business rules, not incidental implementation structure.
- Keep tests deterministic and independent of execution order.
- Put most business-rule coverage in fast tests close to the policy layer.
- Add integration/contract tests at real boundaries where mapping, serialization, persistence, networking, or framework behavior matters.
- Cover negative paths, boundary conditions, retries, cancellation, concurrency, offline/reconnection, and failure reconciliation where relevant.
- A refactor requires evidence that externally observable behavior is preserved.
- Do not weaken tests merely to make a change pass.

## 11. Martin Fowler-style refactoring discipline

- Refactor in small behavior-preserving steps.
- Establish sufficient tests/evidence before changing structure.
- Separate refactoring from unrelated feature changes when possible.
- Prefer established transformations such as rename, extract, inline, move, encapsulate, split phase, introduce parameter object, and replace duplicated conditional knowledge with an appropriate abstraction.
- Re-run relevant verification after meaningful increments rather than deferring all validation to the end.
- Keep rollback points for risky structural migrations.
- Measure before performance optimization; do not justify speculative complexity as optimization.

## 12. Code smells to investigate

These are investigation triggers, not automatic violations:

- duplicated logic or duplicated business decisions
- long function with multiple abstraction levels
- large class/module with unrelated responsibilities
- long parameter list representing hidden concepts
- primitive obsession where domain types would protect invariants
- data clumps repeatedly traveling together
- feature envy / behavior living far from the data or policy it owns
- shotgun surgery where one logical change requires many unrelated edits
- divergent change where one module changes for many unrelated reasons
- deep conditional trees encoding variation that should have a clearer model
- message chains that expose too much internal structure
- middle-man/pass-through layers with no useful policy
- speculative generality
- temporary fields / partially valid object states
- dead code and obsolete migration paths

A reviewer must connect a smell to a concrete maintainability, correctness, testability, or change-cost impact before raising it.

## 13. Simplicity and over-engineering

- Prefer the simplest design that satisfies current requirements and credible near-term variation.
- Do not add repositories, use cases, interfaces, factories, adapters, or base classes solely because a pattern exists.
- Abstractions must earn their cost through boundary protection, testability, reuse, independent variation, or domain clarity.
- Avoid generic frameworks inside the application unless multiple real use cases justify them.
- Do not turn Clean Architecture into a folder-count exercise; dependency direction and ownership matter more than directory names.

## 14. Architecture review decision format

Every material architecture/code-quality finding should explain:

- **WHAT** — the concrete issue
- **EVIDENCE** — file/line, dependency, runtime behavior, test, or command evidence
- **WHY** — the principle or engineering reason
- **IMPACT** — likely effect on correctness, maintainability, security, performance, delivery, or testability
- **HOW** — a precise recommendation
- **PRIORITY** — P0 / P1 / P2 based on risk, not personal preference
- **PRINCIPLE** — the relevant principle from this standards pack or an approved project-specific rule
- **EXCEPTION** — whether an ADR, migration constraint, framework requirement, or deliberate trade-off justifies the current design

## 15. Severity guidance

- **Critical / P0** — correctness, data loss, security, broken architectural boundary that creates immediate systemic risk, or unsafe migration behavior.
- **High / P1** — substantial maintainability, reliability, testability, coupling, or scalability risk likely to affect upcoming work.
- **Medium / P1-P2** — meaningful design debt with bounded impact.
- **Low / P2** — local improvement with limited risk.
- **Info** — observation or optional improvement.

Style preference alone must never be Critical or High.

## 16. Review restraint

- Do not report generic best practices without repository evidence.
- Do not demand a pattern because a book mentions it.
- Do not penalize pragmatic deviations that are explicit, tested, bounded, and justified.
- Do not recommend a refactor whose complexity exceeds the problem it solves.
- Prefer a smaller evidence-backed correction over broad rewrites.

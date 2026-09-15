---
paths:
  - "src/**/__tests__/**"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "jest.config.js"
---

# Testing

- Jest with `@react-native/jest-preset` (`jest.config.js`). Run a suite with
  `yarn jest <pattern>`; the full suite with `yarn jest`.
- Tests live in `__tests__/` next to the unit they cover
  (`src/utils/__tests__/authLoadingState.test.ts` is the model): `describe`
  per behaviour group, `it` sentences that read as the requirement, and a
  one-line regression comment when a test exists because of a bug.
- Extract decision logic into pure functions in `src/utils/` so it can be
  tested without rendering (pattern: `computeLoginLoadingState`).
- `__tests__/` and `*.test.*` are **gitignored** in this repo: new test files
  must be staged with `git add -f`, and the QC report lists untested new logic
  as a 🟡 finding.
- New logic ships with a unit test, or the PR says which device test
  (`/device-qc`) covers it and why a unit test is not possible.
- Never weaken an assertion to make a suite green; fix the code or explain the
  behaviour change in the test's comment.

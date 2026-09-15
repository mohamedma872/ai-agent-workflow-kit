---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---

# Code style (src/**)

- TypeScript, functional components, hooks. No `any` in new code; type API
  payloads in the service file next to the call.
- Imports through the path aliases from `tsconfig.json`: `@/…` (src), `@api/…`,
  `@hooks/…`, `@screens/…`, `@navigation/…`, `@utils/…`, `@assets/…`,
  `@components/…` (top-level `components/`). No deep relative `../../..` paths.
- UI: gluestack-ui components styled with NativeWind class names; follow the
  neighbouring screen's layout pattern before adding a new one.
- Logging through `log` from `@/utils/logger` (`log.info` / `log.error` with a
  short emoji tag and a context object), never bare `console.log` in new code.
- Performance rules the repo lints (`yarn lint:perf`): no inline object /
  array / arrow props on list items or hot paths; `useCallback` / `useMemo`
  where a memoised child receives them; `FlatList` gets a stable `keyExtractor`.
- Every interactive element gets a `testID` (language-independent; QC drives the
  real app through them).
- RTL-safe layout: logical start/end spacing, no hard-coded left/right that
  breaks Arabic; icons that imply direction get mirrored.
- Formatting is Prettier (`.prettierrc.js`) and ESLint (`.eslintrc.js`); the
  pre-commit hook runs lint-staged and `eslint --max-warnings=150` — warnings
  allowed, errors block. Do not disable rules inline to pass.
- No debug rows, mock data, or feature toggles reachable in release builds
  unless gated by `__DEV__`.

---
paths:
  - "src/api/**"
  - "src/hooks/queries/**"
  - "src/hooks/mutations/**"
  - "src/config/**"
---

# API and data conventions

- One service class per backend area in `src/api/services/<Area>Service.ts`,
  extending `BaseService` (`get/post/put/delete<T>` through the shared
  `ApiClient`). Services are instantiated once per module with
  `getApiConfig()` from `@/config/environment`; screens never call axios or
  fetch directly.
- Reads are react-query hooks in `src/hooks/queries/use<Resource>.ts`:
  `queryKey: ['api', '<resource>', params]`, `queryFn` calls the service,
  checks `response.success`, logs with `log.info` / `log.error`, and returns
  the typed `data`. Infinite lists expose `totalElements` from
  `pageable.totalElements` (never the loaded length) for counters.
- Writes are mutation hooks in `src/hooks/mutations/use<Area>Mutations.ts`;
  on success invalidate the exact query keys they affect.
- Environment: base URLs and keys come from `src/config/environment.ts` and
  the `.env.<flavour>` files (sprint / uat / production). Never hard-code a
  URL or key; never read the `.env*` files into the context — reference a key
  by name.
- Errors surface to the user through translated messages; log the request id
  when the backend returns one. A green UI is not a pass when the backend
  cannot persist the write — say BLOCKED.

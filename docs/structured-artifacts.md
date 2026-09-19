# Structured workflow artifacts

The runtime keeps human-readable Markdown while using versioned JSON sidecars as the machine gate for critical stages.

| Stage | Structured artifact | Human view |
|---|---|---|
| Acceptance criteria | `02-acceptance-criteria.json` | `02-acceptance-criteria.md` |
| Plan | `06-plan.json` | `06-plan.md` |
| Build/test | `08-build-test.json` | `08-build-test.md` |
| Reviews | `09-reviews/*.json` | `09-reviews/*.md` |
| Final verification | `11-verification.json` | `11-verification.md` |
| Mobile device evidence | `device/evidence.json` | `device/mobile-device-qc.md` |

For structured stages the executor returns JSON only. The runtime validates the JSON against `ai/workflow/schemas/*.schema.json`, checks the run id and semantic pass conditions, writes a canonical JSON sidecar, and renders the Markdown view from the validated data.

A stage cannot transition to `pass` when its declared structured artifact is missing, malformed, belongs to another run, or fails semantic gates. Review roles are gated individually before their parent `reviews` phase can reconcile to pass.

Key semantic gates are deterministic:

- build/test requires `status: pass`;
- review requires `status: pass` and no unresolved `critical`/`high` finding;
- verification requires `status: pass`, every AC to be `pass` or `not-applicable`, passing ACs to reference evidence, and every DoD item to be `pass` or `not-applicable`;
- plan approval revalidates `06-plan.json` before creating `plan.approved`.

Schemas are validated in CI with:

```bash
npm run workflow:artifacts:check
node ai/workflow/artifacts.js selftest
```

This prevents Markdown wording from becoming an executable control signal. Markdown remains the review surface; structured JSON owns automation decisions.

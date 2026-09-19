# Executor retry, timeout, and fallback policy

Execution policy is declared in `ai/workflows/feature.yaml`. The engine, not the model, decides whether another attempt is allowed.

```yaml
execution_defaults:
  timeout: 60m
  max_attempts: 1
  retry_on: []
  backoff: 0s

roles:
  implementation:
    executor: codex
    fallback: [claude]
    execution:
      timeout: 45m
      max_attempts: 2
      retry_on: [timeout, transient, unavailable]
      backoff: 2s
```

Failure types are deterministic runtime classifications:

- `timeout`: process exceeded its execution timeout;
- `transient`: rate limit, temporary service/network failure, HTTP 429/502/503/504, connection reset, and similar retryable failures;
- `unavailable`: configured executor is unavailable/not installed;
- `deterministic`: code, test, artifact validation, or other repeatable failure;
- `policy`: guardrail/approval/policy denial;
- `success`.

Only failure types listed in `retry_on` may retry. Policy and deterministic failures are never retried blindly. A retry consumes the next configured executor candidate, so `implementation` and `fixes` try Codex first and Claude as fallback on a permitted second attempt.

Every attempt is persisted in `state.json` under `executionAttempts` with attempt id/number, executor, start/end timestamps, status, exit type, and reason. The same event is also appended to workflow history.

Resume behavior reads the persisted attempts. A completed attempt is not rerun. Exhausted attempts remain exhausted. A deterministic or policy failure remains stopped until the underlying run state/work is intentionally changed rather than repeatedly spending tokens on the same failure.

Validation and regression tests:

```bash
npm run workflow:check
node ai/workflow/execution-policy.js --selftest
node ai/workflow/attempts.js --selftest
```

The self-tests cover timeout retry, transient exhaustion, fallback success, deterministic no-retry, persisted attempt history, and resume without rerunning an already-completed execution.

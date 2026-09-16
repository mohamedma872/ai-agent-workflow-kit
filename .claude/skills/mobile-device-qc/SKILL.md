---
name: mobile-device-qc
description: Verify mobile acceptance criteria on Android/iOS using Appium MCP. Creates an isolated device session, executes deterministic AC-driven flows, saves screenshots/evidence to the active run, and closes the session. Read-only with respect to product source.
---

Use Appium MCP for native mobile validation when a `/feature` run has device-level acceptance criteria.

## Preconditions

- An active feature run exists under `ai/runs/<id>/`.
- The app build under test is available/installed or its Appium capabilities identify the app.
- Appium MCP is configured in a Node 22+ MCP environment.
- Android: SDK/ADB available and `ANDROID_HOME` configured.
- iOS: macOS + Xcode/simulator or correctly provisioned real device.

Prefer `NO_UI=true` in the Appium MCP server so screenshots and large UI payloads are saved as files instead of expanding model context.

## Procedure

1. Read only the relevant acceptance criteria, DoD, QA plan, and build/test artifact.
2. Convert the device-relevant ACs into a short ordered checklist. Do not invent extra product behavior.
3. Create or attach an Appium session with `appium_session_management`.
   - Use Android or iOS explicitly.
   - Prefer embedded local drivers for local emulator/simulator runs.
   - Use `remoteServerUrl` only when the project is intentionally using an existing Appium server/device farm.
4. Establish the initial app state. Record platform, device/session id, app/build identifier if available, locale, orientation, and starting screen.
5. Execute each AC deterministically:
   - prefer accessibility ID / resource ID / platform-native selectors;
   - use `appium_find_element` before XPath;
   - use `appium_gesture` for interaction and scrolling;
   - use `appium_context` when a WebView/native transition is part of the flow;
   - do not use vision/AI element lookup unless stable locators are unavailable.
6. Save evidence under the active run directory:
   - screenshots for important checkpoints/failures;
   - page source only when needed to explain a locator/UI failure;
   - screen recording for complex/reproducibility-critical failures;
   - concise text notes mapping each result to its AC.
7. Run both positive and relevant negative paths from the QA plan (offline, permission denial, cancelled prompt, invalid input, RTL, etc.) when applicable.
8. On a failure, capture evidence before changing state. Do not modify product code from this skill.
9. Delete/detach the Appium session at the end, even after a failure.
10. Write/update the run's device-QC artifact with objective results.

## Result format

```text
# Mobile device QC — <request>
Platform: Android | iOS
Device: <name/id>
App/build: <identifier if known>
Session: <id>

| AC | result | evidence | notes |
|---|---|---|---|
| AC-1 | PASS/FAIL | ai/runs/<id>/device/...png | ... |

## Failures
<exact observed behavior + reproducible steps + evidence path, or none>

## Verdict
PASS | FAIL | BLOCKED
```

## Rules

- Device evidence is stronger than an agent statement; save paths, not giant inline base64 payloads.
- Do not commit/push/deploy or change external systems.
- Do not alter test data/accounts unless the approved workflow explicitly allows it.
- Do not leave sessions running after the check.
- Never mark an AC as passed when the device flow was skipped or blocked; use `BLOCKED` or `pending-device`.

---
name: mobile-device-qc
description: Verify mobile acceptance criteria on Android/iOS using Appium MCP for native, React Native, and Flutter apps. Runs the finished feature in headless evidence mode, executes deterministic AC-driven flows, saves final screenshots/evidence to the active run, and closes the session. Read-only with respect to product source.
---

Use Appium MCP for mobile validation when a `/feature` run has mobile or user-visible device behavior. This applies to native Android/iOS, React Native, and Flutter applications.

For a completed mobile/UI feature, screenshot evidence is **required before final verification can pass**.

## Evidence location

Always finish with final device evidence under the active run:

```text
ai/runs/<id>/device/
├── mobile-device-qc.md
└── screenshots/
    ├── 01-launch.png
    ├── 02-ac-1-success.png
    ├── 03-ac-2-error-state.png
    └── ...
```

Use stable, ordered names. Prefer one screenshot for each important user-visible acceptance criterion and one screenshot for each important failure/negative state that is part of the approved QA plan.

## Preconditions

- An active feature run exists under `ai/runs/<id>/`.
- The app build under test is available/installed or its Appium capabilities identify the app.
- Appium MCP is configured in a Node 22+ MCP environment.
- Android: SDK/ADB available and `ANDROID_HOME` configured.
- iOS: macOS + Xcode/simulator or correctly provisioned real device.
- For Flutter, the Android/iOS build under test must represent the final post-fix Flutter app state. Detect flavor/scheme/build configuration from the repository rather than inventing one.
- The workflow classified screenshot evidence as required with:

```bash
node ai/tasks/feature/runs.js evidence required "mobile/UI feature"
```

Prefer `NO_UI=true` in the Appium MCP server. When the local platform supports it, launch the emulator/simulator without a visible window as well. The point of headless evidence mode is that the agent drives the device without requiring an interactive UI while screenshots are still written to files.

## Flutter-specific behavior

Appium still creates an **Android or iOS session** for a Flutter app. Do not label the Appium platform itself as `Flutter`.

- Prefer stable accessibility/semantics identifiers that the Flutter app exposes to the platform accessibility tree.
- If the repository already uses a Flutter-specific Appium driver/plugin, follow that existing setup.
- Do not add a new Appium driver/plugin, change production semantics, or alter product code merely to make automation possible unless that work is part of the approved plan.
- When platform-specific Flutter plugins/channels are involved, verify the relevant Android/iOS behavior as well as the Flutter UI result.

## Procedure

1. Read only the relevant acceptance criteria, DoD, QA plan, build/test artifact, review findings, and final fixes.
2. Treat the post-fix app state as the build under test. Do not capture final evidence from a pre-fix build.
3. Convert the device-relevant ACs into a short ordered checklist. Do not invent extra product behavior.
4. Create or attach an Appium session with `appium_session_management`.
   - Use Android or iOS explicitly, including for Flutter apps.
   - Prefer embedded local drivers for local emulator/simulator runs.
   - Use `remoteServerUrl` only when the project intentionally uses an existing Appium server/device farm.
5. Establish the initial app state. Record framework if known (native / React Native / Flutter), platform, device/session id, app/build identifier if available, locale, orientation, flavor/scheme when relevant, and starting screen.
6. Execute each AC deterministically:
   - prefer accessibility ID / resource ID / platform-native selectors;
   - for Flutter, prefer semantics/accessibility identifiers exposed to the platform;
   - use `appium_find_element` before XPath;
   - use `appium_gesture` for interaction and scrolling;
   - use `appium_context` when a WebView/native transition is part of the flow;
   - do not use vision/AI element lookup unless stable locators are unavailable.
7. Capture screenshots with `appium_screenshot` after each important successful checkpoint and before leaving each important negative/error state.
8. Make sure the final image files end up under:

```text
ai/runs/<id>/device/screenshots/
```

If Appium MCP writes screenshots to its configured `SCREENSHOTS_DIR` (for example `ai/runs/device-artifacts`), use the returned screenshot file path and copy/move the final evidence file into the active run folder above with a stable ordered filename. Only copy files produced by this current device session. Do not scan or publish unrelated run artifacts.

Do not inline screenshot base64 into prompts, artifacts, or the final answer.
9. Run both positive and relevant negative paths from the QA plan (offline, permission denial, cancelled prompt, invalid input, RTL, etc.) when applicable.
10. On a failure, capture evidence before changing state. Do not modify product code from this skill.
11. Delete/detach the Appium session at the end, even after a failure.
12. Write `ai/runs/<id>/device/mobile-device-qc.md` with objective results and screenshot paths.

## Required manifest format

```text
# Mobile device QC — <request>
Framework: Native | React Native | Flutter | other
Platform: Android | iOS
Device: <name/id>
App/build: <identifier if known>
Flavor/scheme: <if relevant>
Session: <id>
Mode: headless evidence

| AC | result | screenshot | notes |
|---|---|---|---|
| AC-1 | PASS/FAIL | ai/runs/<id>/device/screenshots/02-ac-1-success.png | ... |

## Screenshots
- ai/runs/<id>/device/screenshots/01-launch.png — initial feature state
- ai/runs/<id>/device/screenshots/02-ac-1-success.png — AC-1 success

## Failures
<exact observed behavior + reproducible steps + evidence path, or none>

## Verdict
PASS | FAIL | BLOCKED
```

## Verification rule

A mobile/UI `/feature` run cannot be marked `verification = pass` unless:

- screenshot evidence was classified as `required`;
- at least one screenshot exists under `device/screenshots/`;
- `device/mobile-device-qc.md` exists and maps evidence to acceptance criteria;
- required device ACs are not `BLOCKED` or `pending-device`.

This rule applies equally to native, React Native, and Flutter user-facing mobile features.

If Appium, the emulator/simulator, the build, credentials, or required test data are unavailable, mark final verification `blocked`/`pending-device`; do not pretend screenshots were produced.

For backend-only, infrastructure-only, documentation-only, or other genuinely non-UI work, explicitly classify screenshots as not required with a reason:

```bash
node ai/tasks/feature/runs.js evidence not-required "backend-only change"
```

## Rules

- Device evidence is stronger than an agent statement; save paths, not giant inline base64 payloads.
- Capture the **final post-fix feature**, not an intermediate implementation.
- Do not commit/push/deploy or change external systems.
- Do not alter test data/accounts unless the approved workflow explicitly allows it.
- Do not leave sessions running after the check.
- Never mark an AC as passed when the device flow was skipped or blocked; use `BLOCKED` or `pending-device`.

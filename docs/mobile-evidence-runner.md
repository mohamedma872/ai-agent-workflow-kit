# Automatic mobile evidence runner

The workflow does not treat Appium evidence as a documentation-only requirement. Mobile/UI feature runs execute a dedicated runner after fixes and before final verification.

## Command

For the active run:

```bash
npm run workflow:mobile-evidence
```

For a specific run/platform set:

```bash
node ai/tasks/feature/mobile-evidence.js run HM-002 --platforms android,ios
```

Dry run without launching Claude/Appium:

```bash
npm run workflow:mobile-evidence:dry-run
```

## Execution flow

```text
reviews/fixes complete
       ↓
mobile-evidence.js
       ↓
read state.json + target platforms
       ↓
write device/mobile-evidence-context.md
       ↓
router.js exec feature mobile-evidence
       ↓
Claude mobile-evidence role
       ↓
Appium MCP
   ↙         ↘
Android      iOS
   ↓          ↓
fresh screenshots
       ↓
device/mobile-device-qc.md
       ↓
runner validates fresh evidence
       ↓
final verification may continue
```

## Required outputs

For a run such as `HM-002`, verification evidence is stored exactly at:

```text
ai/runs/HM-002/device/mobile-device-qc.md
ai/runs/HM-002/device/screenshots/*.png
```

For multi-platform runs, screenshot names use platform prefixes:

```text
ai/runs/HM-002/device/screenshots/android-01-launch.png
ai/runs/HM-002/device/screenshots/android-02-ac-1-success.png
ai/runs/HM-002/device/screenshots/ios-01-launch.png
ai/runs/HM-002/device/screenshots/ios-02-ac-1-success.png
```

## Freshness protection

The runner records its start time in `state.json` and accepts only the manifest/screenshots created or updated after that attempt begins. Existing files from an older run cannot satisfy the new attempt.

`state.json` receives an execution record similar to:

```json
{
  "evidence": {
    "mobileScreenshots": {
      "requirement": "required",
      "platforms": ["android", "ios"],
      "execution": {
        "status": "pass",
        "role": "mobile-evidence",
        "executor": "claude",
        "startedAt": "...",
        "completedAt": "...",
        "manifest": "ai/runs/HM-002/device/mobile-device-qc.md",
        "screenshots": ["..."]
      }
    }
  }
}
```

## Platform selection

The runner chooses platforms in this order:

1. explicit `--platforms android,ios`;
2. platforms already recorded in the run's mobile evidence state;
3. selected `android` / `ios` analysis roles;
4. `android/` and `ios/` folders found in the target repository.

This allows Android-only or iOS-only features while defaulting cross-platform mobile apps to both platforms when appropriate.

## Failure behavior

The runner returns non-zero and records the attempt as blocked when:

- Appium MCP cannot be used;
- the required emulator/simulator/device is unavailable;
- the final app build is unavailable;
- a target platform was not exercised;
- the manifest is missing or does not end in `PASS`;
- no fresh screenshot exists for a target platform.

Do not bypass this by adding screenshots manually. Fix the Appium/device/build problem or explicitly classify genuinely non-UI work as `not-required`.

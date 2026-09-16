# Flutter support

Flutter is a first-class mobile stack in the AI Agent Workflow Kit.

## What the workflow detects

During repository inspection, Flutter is identified from repository evidence such as:

- `pubspec.yaml` / `pubspec.lock`;
- Flutter/Dart application code under `lib/`;
- `test/` / `integration_test/`;
- Flutter-owned Android/iOS integration folders;
- plugins, platform channels, flavors/schemes and generated-code configuration when present.

The workflow does not treat every Dart package as a Flutter mobile application.

## Specialist routing

For a Flutter feature, `/feature` can select:

- `flutter` → `.claude/agents/flutter-expert.md`;
- `android` when Android-specific manifest/Gradle/permission/plugin behavior changes;
- `ios` when iOS plist/entitlement/Xcode/plugin behavior changes;
- normal `architect`, `qa-plan`, `security`, `performance`, `docs`, `backend` and `frontend` roles as relevant.

Example role registration:

```bash
node ai/tasks/feature/runs.js select-roles analysis architect qa-plan flutter security performance
```

Resolve the Flutter role directly with:

```bash
node ai/workflow/router.js resolve feature flutter --json
```

## Flutter-aware implementation and review

Shared mobile agents are stack-aware. They detect the repository before applying framework-specific guidance:

- `mobile-architect` understands Flutter widget/state/navigation/data/platform boundaries;
- `code-reviewer` reviews Flutter lifecycle, async behavior, null safety, localization/accessibility, scope and tests;
- `security-reviewer` checks Dart packages, secure storage/network/auth behavior, plugins and platform channels;
- `performance-reviewer` checks rebuild scope, lazy lists, startup, async/isolate work, images/assets and plugin/channel cost;
- `android-expert` / `ios-expert` focus on platform integration when Flutter crosses into native configuration or plugins.

## Testing

The QA role reads the repository before selecting commands. Typical Flutter checks may include:

```text
flutter analyze
flutter test
<targeted widget tests>
<integration tests>
<Android/iOS build commands already used by the project>
```

These are examples, not mandatory commands. The workflow must use the project's actual scripts, flavors and test setup.

## Final Appium evidence

Flutter UI features use the same final mobile evidence gate as native and React Native features.

Appium validates the final Flutter app through an **Android or iOS session** after implementation, reviews and fixes. Evidence is stored under:

```text
ai/runs/<id>/device/
├── mobile-device-qc.md
└── screenshots/
    ├── 01-launch.png
    ├── 02-ac-1-success.png
    └── ...
```

Prefer stable accessibility/semantics identifiers exposed to the platform. If the project already uses a Flutter-specific Appium driver/plugin, follow that existing setup; the workflow does not require adding a new automation driver.

A mobile/UI Flutter run cannot mark final verification as passed when required device evidence is missing.

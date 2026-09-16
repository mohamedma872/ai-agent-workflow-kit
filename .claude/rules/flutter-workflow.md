# Flutter workflow rule

Treat Flutter as a first-class mobile stack in `/feature` and `/review`.

## Detect Flutter

A repository is Flutter when evidence such as `pubspec.yaml` plus Flutter/Dart sources is present. During inspection, check for:

- `pubspec.yaml` / `pubspec.lock`;
- `lib/` and Dart sources;
- `test/` / `integration_test/`;
- Flutter-owned `android/` and `ios/` integration folders;
- project flavor/scheme configuration and platform channels/plugins when relevant.

Do not classify an arbitrary Dart-only package as a Flutter mobile application without repository evidence.

## `/feature` routing

When the requested change affects Flutter application behavior, select the `flutter` analysis role:

```bash
node ai/tasks/feature/runs.js select-roles analysis architect qa-plan flutter <other-relevant-roles...>
node ai/workflow/router.js resolve feature flutter --json
```

Also select:

- `android` when Android manifest/Gradle/permissions/native plugin behavior is affected;
- `ios` when Info.plist/Xcode/entitlements/native plugin behavior is affected;
- `security`, `performance`, `docs`, `backend`, or `frontend` according to the normal selective-analysis rules.

Flutter does not replace Android/iOS expertise when native platform behavior changes.

## Testing

Use the repository's actual Flutter commands and conventions. Typical checks may include `flutter analyze`, `flutter test`, targeted widget tests, integration tests, and Android/iOS builds, but never invent scripts the project does not support.

For mobile/UI features, final screenshot evidence remains required. Appium validates the finished Flutter app through its Android or iOS build after reviews/fixes, and screenshots are saved under:

```text
ai/runs/<id>/device/screenshots/
```

Prefer stable accessibility/semantics identifiers exposed to the platform. If the repository already has a Flutter-specific Appium driver/plugin, use that existing setup; otherwise do not add a new automation stack merely to satisfy the workflow.

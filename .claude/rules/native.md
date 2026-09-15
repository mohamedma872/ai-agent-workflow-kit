---
paths:
  - "android/**"
  - "ios/**"
  - "fastlane/**"
---

# Native folders (android/, ios/, fastlane/)

- Flavours: Android `sprint` / `uat` / `prod` (`com.example.app[.sprint|.uat]`),
  iOS schemes `App Sprint` / `App UAT` / `App`. A native change
  must work for all three.
- Never read or modify signing material: `android/app/*.keystore`,
  provisioning profiles, certificates, `fastlane/.env*` — reference by path;
  the fence denies reads anyway.
- Android: `targetSdk 36`, predictive back opted out, four ABIs in the store
  AAB, one ABI (`arm64-v8a`) for debug builds. Manifest permission changes
  need a Play Data-safety review note.
- iOS: every new capability needs its `Info.plist` usage string (e.g.
  `NSFaceIDUsageDescription`), iPad allows all four orientations, builds need
  `DEVELOPER_DIR` pointing at the real Xcode on this machine.
- A change here gets `android-expert` / `ios-expert` analysis in `/feature`
  and their review afterwards; release lanes live in `fastlane/Fastfile`
  (see the `release` skill) and uploading asks first.

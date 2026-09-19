# Mobile evidence attestation

A passing mobile verification is bound to the exact Appium attempt, source workspace, build artifact, manifest, and screenshots.

For each required Android/iOS platform, `device/appium-sessions.json` must record:

```json
{
  "attemptId": "RUN-2026-...",
  "platforms": [
    {
      "platform": "android",
      "sessionId": "<real Appium session id>",
      "deviceId": "emulator-5554",
      "appId": "com.example.app",
      "appVersion": "2.1.0",
      "buildNumber": "123",
      "buildArtifact": "android/app/build/outputs/apk/debug/app-debug.apk",
      "environment": "uat",
      "sessionStartedAt": "2026-09-17T20:00:00.000Z",
      "sessionEndedAt": "2026-09-17T20:05:00.000Z"
    }
  ]
}
```

For iOS, `buildArtifact` can be an IPA or an `.app` directory. Directory artifacts are hashed deterministically from their relative file names/content hashes.

The runtime generates `device/evidence.json`; the agent does not generate its hashes. The attestation contains:

- current Git commit SHA;
- current working-tree fingerprint, including tracked diffs and untracked file hashes;
- actual Appium session/device metadata;
- package/bundle id, marketing version, build number;
- flavor/scheme/environment when applicable;
- exact build artifact path + SHA-256;
- manifest path + SHA-256;
- every evidence screenshot path + SHA-256.

Final verification revalidates those hashes and identities. Changing the build, screenshot, manifest, commit, workspace, attempt, or required platform invalidates the evidence.

`appium-sessions.json`, `mobile-device-qc.md`, and screenshots must be fresh for the current attempt. Stale/copied artifacts are rejected before attestation.

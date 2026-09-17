# Mobile evidence execution rule

For `/feature` runs with `state.json.evidence.mobileScreenshots.requirement = "required"`, final verification must execute the repository's mobile evidence runner after fixes and before `verification = pass`:

```bash
npm run workflow:mobile-evidence
```

Equivalent explicit form:

```bash
node ai/tasks/feature/mobile-evidence.js run <run-id>
```

Do not replace this command with a prose statement, a manual screenshot, or a claim that Appium should be run later. The runner invokes the routed `mobile-evidence` role, which must use Appium MCP.

Required outputs are exactly:

```text
ai/runs/<id>/device/mobile-device-qc.md
ai/runs/<id>/device/screenshots/*.png
```

The runner accepts only fresh evidence generated after the current attempt starts. For Android/iOS targets, screenshots use `android-` / `ios-` prefixes and the manifest documents every required platform.

If the runner fails or Appium/device/build access is unavailable, final verification is blocked. Never mark `verification = pass` by bypassing or fabricating mobile evidence.

For runs explicitly classified `not-required`, the runner exits successfully as skipped and final verification may continue.

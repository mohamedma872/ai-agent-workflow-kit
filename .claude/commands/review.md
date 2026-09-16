---
description: Independent review of the current diff by the specialist subagents (security, code, performance, plus platform experts when their stack is touched); findings with severity and file:line, then a triage table. Usage — /review [PROJ-123 or a note about what changed]
---

Review the current working-tree diff independently, without editing anything.

1. Run `git status --porcelain` and `git diff HEAD --stat`. If there is no diff,
   say so and stop.
2. Decide the reviewers: `security-reviewer` (mode `diff-review`) and
   `code-reviewer` always; `performance-reviewer` (mode `diff-review`) when
   screens, lists, hooks/queries, widgets, startup code, rendering, or networking changed;
   `android-expert` / `ios-expert` in review mode when `android/` or `ios/` changed;
   `flutter-expert` when a Flutter repository changes `pubspec.yaml`, `lib/`, `test/`,
   `integration_test/`, Flutter plugin/channel code, or Flutter-specific build/runtime behavior.
   A Flutter change that also changes native Android/iOS behavior may need both
   `flutter-expert` and the affected platform expert.
3. Launch them in parallel — one Agent call per reviewer in the SAME message,
   `run_in_background: true` — each with: what changed ($ARGUMENTS if given),
   the instruction to run `git diff` themselves, and "return your report in
   your required structure". Wait for all.
4. Present one triage table:

   | reviewer | severity | file:line | issue | valid? | proposed fix |

   Mark each finding `valid` or `rejected` with a one-line reason. Do not fix
   anything in this command; end with the list of valid findings to apply and
   the overall verdict (APPROVE / REQUEST CHANGES / BLOCK).

If an active `/feature` run exists (`node ai/tasks/feature/runs.js status`),
also save each report to `ai/runs/<id>/09-reviews/<reviewer>.md` and the
triage table to `ai/runs/<id>/10-fixes.md`.

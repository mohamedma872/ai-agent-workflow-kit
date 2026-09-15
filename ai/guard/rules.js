'use strict';
// OPTIONAL project-wide checks in code. Most rules do NOT belong here — they
// are written in plain YAML: ai/guard.yaml (the fence) and
// ai/tasks/<task>/guard.yaml (a task's own rules). The engine discovers task
// folders by itself. Use this file only for a project-wide check that must
// read state or compute something (same API as a task's guard.js):
//   secretFiles: [glob or RegExp]   guardedFiles: [glob or RegExp]
//   secrets(): [string]             rules(payload, ctx, { deny, ask })
module.exports = {
  rules() { /* nothing project-wide beyond the YAML files */ },
};

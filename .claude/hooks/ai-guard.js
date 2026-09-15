#!/usr/bin/env node
'use strict';
// Shim kept for old wiring. The fence lives in ai/guard/engine.js (rules in
// ai/guard.yaml); .claude/settings.json calls the engine directly.
require('../../ai/guard/engine.js').main();

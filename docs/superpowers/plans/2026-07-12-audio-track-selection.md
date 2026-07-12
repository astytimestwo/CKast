# Audio Track Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immediate MPV audio-track switching without interrupting playback or TV synchronization.

**Architecture:** Make MPV's `track-list` and `aid` properties authoritative. Normalize live audio tracks in `MpvController`, expose them through existing player status, add one validated server route, and bind a dashboard selector directly to that route.

**Tech Stack:** Node.js 20+, MPV JSON IPC, Express, browser JavaScript, Node test runner.

## Global Constraints

- Work directly on local `main` as explicitly requested.
- Preserve the user's uncommitted `tv-app/js/main.js` IP change.
- Switching audio must not seek, pause, restart MPV/FFmpeg, or send TV controls.
- Use test-first implementation and run the complete regression suite.
- Do not push or contact GitHub.

---

### Task 1: MPV live audio-track state and selection

**Files:**
- Modify: `pc-broadcaster/lib/mpvController.js`
- Modify: `pc-broadcaster/test/mpvController.test.js`

- [x] Add failing tests for normalized `track-list`, selected `aid`, validated selection, state clearing, and a single `set_property aid` command.
- [x] Implement `normalizeAudioTracks`, `setAudioTrack`, `track-list`/`aid` refresh and observation, and state reset.
- [x] Run `node --test test/mpvController.test.js`.

### Task 2: API and dashboard selector

**Files:**
- Modify: `pc-broadcaster/server.js`
- Modify: `pc-broadcaster/public/dashboard.html`
- Modify: `pc-broadcaster/test/serverLifecycle.test.js`
- Modify: `pc-broadcaster/test/dashboard.test.js`

- [x] Add failing contract tests for `POST /api/player/audio-track`, the selector, labels, disabled state, request payload, and error rollback.
- [x] Add the server route that calls only `player.setAudioTrack(req.body.audioTrackId)`.
- [x] Add and render the selector from player status; on change, update through the route and restore the confirmed state on failure.
- [x] Run focused controller, server-contract, and dashboard tests.

### Task 3: Documentation, verification, and local commit

**Files:**
- Modify: `README.md`
- Modify: `pc-broadcaster/README.md`
- Modify: this plan's checkboxes

- [x] Document immediate PC audio-track selection.
- [x] Run `npm test`, `npm run check`, syntax-check all JavaScript, and `git diff --check`.
- [x] Confirm `tv-app/js/main.js` remains uncommitted and unchanged by this implementation.
- [x] Commit only audio-track feature, tests, documentation, spec, and plan; do not push.

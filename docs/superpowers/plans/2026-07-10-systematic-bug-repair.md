# CKast Systematic Bug Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the confirmed lifecycle, synchronization, pacing, receiver-state, timing, and operational defects documented in `docs/bug-hunt-2026-07-10.md`.

**Architecture:** Introduce generation-aware process/session primitives, make one server-owned TV mode authoritative, and route every file-video restart through one pause/reset/readiness/resume sequence. Pace file input in real time, start only from receiver buffer telemetry, and give the Tizen MSE pipeline its own generation guard and bounded recovery behavior.

**Tech Stack:** Node.js 16+, Express, `ws`, FFmpeg/FFprobe, MPV JSON IPC, Samsung Tizen Web App, Media Source Extensions, Node test runner.

## Global Constraints

- Preserve all pre-existing user edits in `README.md`, `dev_operating_guide.md`, `tv-app/README.md`, `tv-app/index.html`, `tv-app/js/main.js`, and `pc-broadcaster/test/tvLayout.test.js`.
- Do not commit or stage the dirty working tree unless the user explicitly requests it.
- Write each regression test first and observe its expected failure before production changes.
- Never allow desktop and file FFmpeg processes to own the TV stream simultaneously.
- TV binary fragments and telemetry must belong to one current socket/session generation.
- MPV remains the PC audio clock and must launch with video disabled.
- File autoplay occurs only after TV telemetry proves the requested buffer target.

---

### Task 1: Make MPV process ownership generation-safe and audio-only

**Files:**
- Modify: `pc-broadcaster/lib/mpvController.js`
- Create: `pc-broadcaster/test/mpvController.test.js`

**Interfaces:**
- `new MpvController({ spawnProcess?, connectSocket?, now? } = {})`
- `stop(): Promise<status>` remains compatible.
- `open(filePath): Promise<status>` must leave no process on failure.

- [ ] **Step 1: Add failing process-lifecycle tests**

Use fake EventEmitter processes/sockets to prove that a stale old `exit` cannot clear a new process, IPC timeout calls cleanup, socket close rejects pending commands, stop clears the parse buffer, and spawn args contain `--video=no` but not `--force-window=yes`.

```js
test('stale MPV exit cannot clear a replacement process', async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const controller = createControllerWithProcesses([first, second]);
    await controller.startProcess();
    await controller.stop();
    await controller.startProcess();
    first.emit('exit', 0);
    assert.equal(controller.process, second);
});

test('MPV launches audio-only', async () => {
    const spawnCall = await captureSpawnArgs();
    assert.ok(spawnCall.args.includes('--video=no'));
    assert.ok(!spawnCall.args.includes('--force-window=yes'));
});
```

- [ ] **Step 2: Run the new test file and verify the stale-exit/audio-only assertions fail**

Run: `node --test test/mpvController.test.js`

- [ ] **Step 3: Guard callbacks by captured process/socket identity and centralize cleanup**

Implement `rejectPending(error)`, `resetIpcState()`, and identity checks:

```js
const mpvProcess = this.spawnProcess(mpvPath.command, args, spawnOptions);
this.process = mpvProcess;
mpvProcess.once('exit', (code) => {
    if (this.process !== mpvProcess) return;
    this.rejectPending(new Error('MPV exited'));
    this.resetIpcState();
    this.process = null;
});
```

Wrap `connectPipe()` in `try/catch` inside `startProcess()` and kill only the captured process when startup fails.

- [ ] **Step 4: Run MPV tests, then the complete suite**

Run: `node --test test/mpvController.test.js && npm test`

---

### Task 2: Replace desktop globals with a tested DesktopCapture lifecycle

**Files:**
- Create: `pc-broadcaster/lib/desktopCapture.js`
- Create: `pc-broadcaster/test/desktopCapture.test.js`
- Modify: `pc-broadcaster/server.js`

**Interfaces:**
- `new DesktopCapture({ spawnProcess?, mp4fragFactory?, ffmpegCommand?, watchdogMs? })`
- Events: `initialized`, `segment`, `error`, `restart`, `close`.
- Methods: `start(sendSegment)`, `stop()`, `shutdown()`, `getStatus()`.

- [ ] **Step 1: Write failing tests for startup watchdog, stale close, dead status, and configured FFmpeg path**

```js
test('unexpected close clears active status and schedules one restart', async () => {
    const capture = createCapture({ watchdogMs: 10 });
    capture.start(() => {});
    capture.process.emit('close', 1);
    assert.equal(capture.getStatus().active, false);
    await delay(20);
    assert.equal(capture.spawnCount, 2);
});

test('stale close cannot cancel replacement watchdog', () => {
    const { capture, first, second } = startTwice();
    first.emit('close', 0);
    assert.equal(capture.process, second);
    assert.equal(capture.getStatus().watchdogArmed, true);
});
```

- [ ] **Step 2: Verify the new tests fail because DesktopCapture does not exist**

Run: `node --test test/desktopCapture.test.js`

- [ ] **Step 3: Implement DesktopCapture using the guarded FileVideoStreamer pattern**

Arm the watchdog immediately after spawn, reset it for init/segments, guard all handlers with `if (this.process !== process) return`, and report active status from the captured live process only. Resolve FFmpeg through `resolveFfmpegPath()`.

- [ ] **Step 4: Replace `S.ffmpegProcess`, `S.mp4frag`, init-segment globals, and watchdog functions in the server**

Keep mirror timing fields in server state, but subscribe to DesktopCapture events for initialization and segments.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/desktopCapture.test.js && npm test`

---

### Task 3: Establish one authoritative TV session and socket generation

**Files:**
- Create: `pc-broadcaster/lib/tvSession.js`
- Create: `pc-broadcaster/test/tvSession.test.js`
- Modify: `pc-broadcaster/server.js`

**Interfaces:**
- Modes: `'idle' | 'desktop' | 'file'`.
- `replaceSocket(socket)` closes/invalidates the previous socket and increments generation.
- `beginMode(mode)` increments stream generation, clears telemetry, and cancels pending readiness.
- `acceptTelemetry(socket, payload)` returns false for non-current sockets.
- `sendControl(payload)` and `sendSegment(chunk, kind)` operate only for the current generation.

- [ ] **Step 1: Add failing tests for superseded sockets, mutually exclusive modes, reconnect handshake, and stale pending resume**

```js
test('superseded socket telemetry is ignored', () => {
    const session = new TvSession();
    session.replaceSocket(first);
    session.replaceSocket(second);
    assert.equal(session.acceptTelemetry(first, { currentTime: 111 }), false);
});

test('mode transition cancels prior readiness', () => {
    const session = new TvSession();
    session.beginMode('file');
    session.armReadiness({ bufferSeconds: 5 });
    session.beginMode('desktop');
    assert.equal(session.getStatus().pendingReadiness, null);
});
```

- [ ] **Step 2: Verify the TV-session tests fail**

Run: `node --test test/tvSession.test.js`

- [ ] **Step 3: Implement TvSession and integrate socket ownership**

On connection, invalidate/close the old socket, reset telemetry and mirror baselines, then send an authoritative handshake in this order:

```js
sendTvControl({ type: 'reset', mode, autoPlay: false, generation });
sendModeOptions(mode);
sendCurrentInitializationSegment(mode);
```

Ignore messages unless `ws === tvSession.socket`.

- [ ] **Step 4: Make stream modes mutually exclusive and gate controls**

Starting desktop stops file video and cancels file readiness. Starting file stops desktop. File play/pause/seek/stop controls are sent to the TV only when current TV mode is `file`. Desktop Stop sends `stop` and changes the mode to idle.

- [ ] **Step 5: Run session tests and the complete suite**

Run: `node --test test/tvSession.test.js && npm test`

---

### Task 4: Pace file streaming and replace blind timers with telemetry readiness

**Files:**
- Modify: `pc-broadcaster/lib/fileVideoStreamer.js`
- Modify: `pc-broadcaster/server.js`
- Modify: `pc-broadcaster/lib/fileSync.js`
- Modify: `pc-broadcaster/test/fileVideoStreamer.test.js`
- Modify: `pc-broadcaster/test/fileSync.test.js`
- Create: `pc-broadcaster/test/filePlaybackLifecycle.test.js`

**Interfaces:**
- File FFmpeg args include `-re` before `-i`.
- Pending readiness stores `{ generation, targetBufferSeconds, requestedAt }`.
- `isFilePlaybackReady(tvState, pending)` requires matching file mode, finite buffer ahead, adequate readyState, and the requested target.
- `restartFilePlayback({ startTime, resume })` is the only route used by initial start, seek, options, nudge, and reconnect.

- [ ] **Step 1: Write failing pacing/readiness/restart tests**

```js
test('file input is paced in real time', () => {
    const args = capturedFfmpegArgs();
    assert.ok(args.indexOf('-re') < args.indexOf('-i'));
});

test('autoplay waits for matching TV buffer readiness', () => {
    assert.equal(isFilePlaybackReady({ playbackMode: 'file', bufferAhead: 4.9 }, pending5s), false);
    assert.equal(isFilePlaybackReady({ playbackMode: 'file', bufferAhead: 5.0, readyState: 4 }, pending5s), true);
});

test('options restart pauses audio before resetting video', async () => {
    await coordinator.restartFilePlayback({ resume: true });
    assert.deepEqual(callOrder.slice(0, 3), ['player.pause', 'tv.reset', 'ffmpeg.restart']);
});
```

- [ ] **Step 2: Verify focused tests fail for missing pacing and readiness**

Run: `node --test test/fileVideoStreamer.test.js test/filePlaybackLifecycle.test.js`

- [ ] **Step 3: Add `-re` and preserve synchronization through encoder EOF**

Treat `mode === 'ended'` with a retained file path as syncable until player time reaches duration or the session is stopped.

- [ ] **Step 4: Replace `syncResumeTimer` with generation-bound readiness**

Pause MPV, start/restart FFmpeg, arm readiness, and resume both only from `handleTvSyncState()` after the target buffer is observed. Do not auto-play on a timeout; expose a readiness timeout error in status instead.

- [ ] **Step 5: Route options and nudge through `restartFilePlayback()`**

Remove the duplicated restart blocks so audio is always paused and the same readiness gate is used.

- [ ] **Step 6: Run focused, full, and real-rate diagnostics**

Run: `node --test test/fileVideoStreamer.test.js test/fileSync.test.js test/filePlaybackLifecycle.test.js && npm test`

Confirm a 12-second fixture takes approximately 12 seconds—not under one second—to emit fully.

---

### Task 5: Make the Tizen MSE pipeline generation-safe and bounded

**Files:**
- Create: `pc-broadcaster/test/helpers/tvRuntimeHarness.js`
- Create: `pc-broadcaster/test/tvRuntime.test.js`
- Modify: `tv-app/js/main.js`
- Modify: `pc-broadcaster/test/tvLayout.test.js`

**Interfaces:**
- `pipelineGeneration` increments on every clear/reset.
- MediaSource and SourceBuffer handlers capture `{ generation, instance }` and return when stale.
- `pause` always sets `shouldAutoPlay=false`.
- `MAX_QUEUE_SEGMENTS` bounds receiver queue; overflow closes the socket to trigger an authoritative reconnect.
- Buffer history target is 10 seconds; eviction retries queue processing after `updateend`.

- [ ] **Step 1: Build a reusable VM harness around the actual receiver script**

The harness supplies fake DOM, MediaSource, SourceBuffer, WebSocket, timers, and exposes sent telemetry plus playback calls without copying receiver logic.

- [ ] **Step 2: Add failing behavioral tests for the three reproduced receiver races**

```js
test('file to desktop transition re-enables fixed latency', () => {
    const app = createTvRuntime();
    app.sendFileMode();
    app.sendDesktopMode();
    assert.equal(app.lastSyncState().fixedLatency.enabled, true);
});

test('pause before first append remains paused', () => {
    const app = createTvRuntime();
    app.playThenPauseBeforeFirstChunk();
    app.appendFirstChunk();
    assert.equal(app.video.paused, true);
});

test('stale sourceopen cannot mutate replacement pipeline', () => {
    const app = createTvRuntime();
    app.fireOldSourceOpenAfterReset();
    assert.equal(app.newMediaSource.addSourceBufferCalls, 0);
});
```

- [ ] **Step 3: Verify receiver tests fail under current code**

Run: `node --test test/tvRuntime.test.js`

- [ ] **Step 4: Add generation guards, pause semantics, send error handling, queue cap, and shorter eviction**

Capture local instances inside `createMediaPipeline()` and check both generation and identity in every callback. Wrap sync sends in `try/catch`. On queue overflow close the current WebSocket with a retryable code rather than dropping arbitrary fMP4 fragments.

- [ ] **Step 5: Run receiver and full tests**

Run: `node --test test/tvRuntime.test.js test/tvLayout.test.js && npm test`

---

### Task 6: Correct timing, start-time, subtitle, and streamer transaction semantics

**Files:**
- Modify: `pc-broadcaster/lib/mirrorSync.js`
- Modify: `pc-broadcaster/lib/fixedLatency.js`
- Modify: `pc-broadcaster/lib/fileVideoStreamer.js`
- Modify: `pc-broadcaster/server.js`
- Modify: `pc-broadcaster/test/mirrorSync.test.js`
- Modify: `pc-broadcaster/test/fixedLatency.test.js`
- Modify: `pc-broadcaster/test/fileVideoStreamer.test.js`
- Modify: `pc-broadcaster/test/subtitle.test.js`

**Interfaces:**
- `calculateMirrorLagSeconds({ captureStartedAtMs, nowMs, tvCurrentTimeSeconds })` uses one shared zero-based media timeline.
- `finiteNumber(null|undefined)` returns null in fixed-latency math.
- Explicit `startTime: 0` remains zero.
- Subtitle filters see absolute source time and output is rebased to zero.
- Failed streamer setup returns to `idle` with `error` populated.

- [ ] **Step 1: Add failing regression tests for all five timing/transaction defects**

```js
test('mirror lag uses TV absolute media time', () => {
    assert.equal(calculateMirrorLagSeconds({
        captureStartedAtMs: 0,
        nowMs: 10000,
        tvCurrentTimeSeconds: 9
    }), 1);
});

test('missing buffer telemetry is not zero', () => {
    const control = calculateFixedLatencyControl({ actualLagSeconds: 3, bufferAheadSeconds: null });
    assert.equal(control.liveEdgeLagSeconds, null);
    assert.equal(control.targetSeconds, 2.5);
});
```

- [ ] **Step 2: Verify tests fail with the current calculations and FFmpeg filter chain**

Run: `node --test test/mirrorSync.test.js test/fixedLatency.test.js test/subtitle.test.js test/fileVideoStreamer.test.js`

- [ ] **Step 3: Correct mirror and null math, and preserve explicit zero**

Use null-aware parsing rather than `Number(value) || fallback` for semantically valid zero values.

- [ ] **Step 4: Rebase subtitle-filter timestamps around absolute source time**

For subtitle-enabled restarts at `startTime > 0`, build this filter order:

```text
setpts=PTS+<startTime>/TB,subtitles=...,setpts=PTS-STARTPTS
```

Validate with the fixture: the cue spanning source second 6 must appear on the first frame of a restart at 6, while the cue spanning source second 1 must not appear at output second 1.2.

- [ ] **Step 5: Make FileVideoStreamer setup transactional**

Validate/build subtitle filters before publishing `mode='starting'`, or catch setup errors and restore idle state with a useful error.

- [ ] **Step 6: Run focused tests and complete suite**

Run: `node --test test/mirrorSync.test.js test/fixedLatency.test.js test/subtitle.test.js test/fileVideoStreamer.test.js && npm test`

---

### Task 7: Bound transport pressure and expose useful diagnostics

**Files:**
- Modify: `pc-broadcaster/lib/tvSession.js`
- Modify: `pc-broadcaster/server.js`
- Modify: `pc-broadcaster/public/dashboard.html`
- Modify: `pc-broadcaster/test/tvSession.test.js`
- Create: `pc-broadcaster/test/dashboard.test.js`

**Interfaces:**
- `MAX_SOCKET_BUFFERED_BYTES = 8 * 1024 * 1024`.
- Segment stats update count, bytes, congestion/reconnect count, and last event.
- Dashboard polling has one `statusRequestInFlight` guard.
- Action errors remain visible until a successful action or materially newer server state supersedes them.

- [ ] **Step 1: Add failing WebSocket high-water and dashboard polling tests**

```js
test('socket high-water mark triggers controlled reconnect instead of more sends', () => {
    socket.bufferedAmount = MAX_SOCKET_BUFFERED_BYTES + 1;
    assert.equal(session.sendSegment(fragment, 'file'), false);
    assert.equal(socket.closeCode, 1013);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test test/tvSession.test.js test/dashboard.test.js`

- [ ] **Step 3: Enforce high-water behavior and publish segment stats in `/status`**

Do not drop individual media fragments. Close the congested socket, preserve encoder safety, and use the reconnect handshake/restart path from Tasks 3–4.

- [ ] **Step 4: Prevent overlapping dashboard polls and harden action errors**

Use `try/finally` around a boolean in-flight guard and add `try/catch` to capture start/stop handlers.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/tvSession.test.js test/dashboard.test.js && npm test`

---

### Task 8: Safe shutdown, launcher hardening, and final end-to-end audit

**Files:**
- Modify: `pc-broadcaster/server.js`
- Modify: `pc-broadcaster/start.bat`
- Modify: `pc-broadcaster/README.md`
- Modify: `README.md`
- Modify: `dev_operating_guide.md`
- Update: `docs/bug-hunt-2026-07-10.md`

**Interfaces:**
- `shutdown(signal)` is idempotent and stops desktop capture, file video, MPV, timers/readiness, sockets, then HTTP server.
- Launcher changes directory to `%~dp0` and terminates only the listener PID proven to own local port 8080; it does not globally kill `server.js` processes or remote-port matches.

- [ ] **Step 1: Add a shutdown integration test using injected/fake child resources**

Verify two shutdown calls stop each resource exactly once.

- [ ] **Step 2: Implement `SIGINT`, `SIGTERM`, and server-error cleanup**

Register handlers after server construction and make shutdown safe during partial startup.

- [ ] **Step 3: Replace destructive launcher discovery**

Start with `cd /d "%~dp0"`; query only `LISTENING` rows whose local endpoint is `:8080`, and terminate only that owning PID.

- [ ] **Step 4: Update operational documentation to match paced readiness and new status behavior**

Remove statements claiming a five-second blind delay or unrestricted watchdog behavior.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```powershell
cd pc-broadcaster
npm test
npm run check
node --test --experimental-test-coverage
```

Then run live diagnostics:

1. Desktop start → kill owned FFmpeg → verify one restart and truthful status.
2. File synced start with fake/real TV telemetry → verify MPV remains paused below target and starts at target.
3. Switch file → desktop → file and verify only one encoder and correct receiver mode.
4. Connect a second TV socket and verify first-socket telemetry is ignored.
5. Restart a subtitle stream at six seconds and verify the active cue.
6. Rapid MPV stop/open and verify one MPV process remains, then zero after stop.

- [ ] **Step 6: Completion audit against every finding**

For each numbered finding in `docs/bug-hunt-2026-07-10.md`, link the regression test or live diagnostic proving resolution. Leave any unproven item open rather than declaring completion.

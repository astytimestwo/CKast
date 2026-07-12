const assert = require('assert');
const test = require('node:test');

const { FilePlaybackCoordinator } = require('../lib/filePlaybackCoordinator');
const { TvSession } = require('../lib/tvSession');

function createCoordinator(options = {}) {
    const calls = [];
    const tvSession = new TvSession();
    const player = {
        async pause() { calls.push('player.pause'); },
        async setSpeed(speed) { calls.push('player.speed:' + speed); },
        async play() { calls.push('player.play'); }
    };
    const fileVideo = {
        start(filePath, options) {
            calls.push('video.start:' + filePath + '@' + options.startTime);
        },
        restartAt(startTime) {
            calls.push('video.restart@' + startTime);
        },
        stop() {
            calls.push('video.stop');
        }
    };
    const coordinator = new FilePlaybackCoordinator({
        player,
        fileVideo,
        tvSession,
        getStreamOptions: () => ({ bitrateKbps: 8000 }),
        sendSegment() {},
        sendControl(payload) { calls.push('tv.' + payload.type); },
        resetTv(reason) { calls.push('tv.reset:' + reason); },
        resetStats() { calls.push('stats.reset'); },
        onResume() { calls.push('resume.notified'); },
        readinessTimeoutMs: options.readinessTimeoutMs,
        now: options.now
    });
    return { coordinator, tvSession, calls };
}

test('file restart pauses audio before resetting and restarting TV video', async () => {
    const { coordinator, calls, tvSession } = createCoordinator();

    await coordinator.restart({
        startTime: 12,
        resume: true,
        targetBufferSeconds: 5,
        reason: 'options'
    });

    assert.deepEqual(calls, [
        'player.pause',
        'player.speed:1',
        'tv.reset:options',
        'stats.reset',
        'video.restart@12'
    ]);
    assert.equal(tvSession.mode, 'file');
    assert.equal(tvSession.pendingReadiness.targetBufferSeconds, 5);
});

test('initial file start uses the same pause reset readiness sequence', async () => {
    const { coordinator, calls } = createCoordinator();

    await coordinator.restart({
        filePath: 'movie.mkv',
        startTime: 0,
        resume: true,
        targetBufferSeconds: 3,
        reason: 'initial'
    });

    assert.deepEqual(calls, [
        'player.pause',
        'player.speed:1',
        'tv.reset:initial',
        'stats.reset',
        'video.start:movie.mkv@0'
    ]);
});

test('file playback resumes only after matching TV readiness telemetry', async () => {
    const { coordinator, calls, tvSession } = createCoordinator();
    await coordinator.restart({
        filePath: 'movie.mkv',
        startTime: 0,
        resume: true,
        targetBufferSeconds: 5,
        reason: 'initial'
    });
    const generation = tvSession.generation;

    assert.equal(await coordinator.resumeIfReady({
        generation,
        readyState: 4,
        fixedLatency: { playbackMode: 'file', bufferAheadSeconds: 4.9 }
    }), false);
    assert.ok(!calls.includes('player.play'));

    assert.equal(await coordinator.resumeIfReady({
        generation,
        readyState: 4,
        fixedLatency: { playbackMode: 'file', bufferAheadSeconds: 5 }
    }), true);
    assert.deepEqual(calls.slice(-4), [
        'player.speed:1',
        'tv.play',
        'player.play',
        'resume.notified'
    ]);
    assert.equal(tvSession.pendingReadiness, null);
});

test('mode change invalidates a pending file resume', async () => {
    const { coordinator, calls, tvSession } = createCoordinator();
    await coordinator.restart({
        filePath: 'movie.mkv',
        startTime: 0,
        resume: true,
        targetBufferSeconds: 1,
        reason: 'initial'
    });
    const oldGeneration = tvSession.generation;
    tvSession.beginMode('desktop');

    assert.equal(await coordinator.resumeIfReady({
        generation: oldGeneration,
        readyState: 4,
        fixedLatency: { playbackMode: 'file', bufferAheadSeconds: 10 }
    }), false);
    assert.ok(!calls.includes('player.play'));
});

test('stopping file playback clears readiness before stopping the TV stream', async () => {
    const { coordinator, calls, tvSession } = createCoordinator();
    tvSession.beginMode('file');
    tvSession.armReadiness({ targetBufferSeconds: 5 });

    await coordinator.stop('open_new_file');

    assert.deepEqual(calls, ['tv.stop', 'video.stop']);
    assert.equal(tvSession.pendingReadiness, null);
    assert.equal(tvSession.mode, 'idle');
});

test('file readiness timeout is reported without starting playback', async () => {
    let nowMs = 1000;
    const { coordinator, calls, tvSession } = createCoordinator({
        readinessTimeoutMs: 30000,
        now: () => nowMs
    });
    await coordinator.restart({
        filePath: 'movie.mkv',
        startTime: 0,
        resume: true,
        targetBufferSeconds: 5,
        reason: 'initial'
    });
    tvSession.pendingReadiness.requestedAt = nowMs;
    nowMs += 30001;

    const status = coordinator.getStatus();

    assert.equal(status.readinessTimedOut, true);
    assert.ok(!calls.includes('player.play'));
});

test('initial alignment pending flag transitions correctly', async () => {
    const { coordinator, tvSession } = createCoordinator();
    
    assert.equal(coordinator.getStatus().initialAlignmentPending, false);

    await coordinator.restart({
        filePath: 'movie.mkv',
        startTime: 0,
        resume: true,
        targetBufferSeconds: 5
    });

    assert.equal(coordinator.getStatus().initialAlignmentPending, true);

    await coordinator.stop();

    assert.equal(coordinator.getStatus().initialAlignmentPending, false);
});

const assert = require('assert');
const test = require('node:test');

const { createTvRuntime } = require('./helpers/tvRuntimeHarness');

function enterFileMode(app) {
    app.sendControl({
        type: 'fixedLatency',
        mode: 'file',
        options: { enabled: false, targetSeconds: 0.5, minBufferSeconds: 0.25 }
    });
    app.sendControl({ type: 'reset', mode: 'file', autoPlay: false });
}

test('pause before the first file chunk remains paused', () => {
    const app = createTvRuntime();
    app.socket.onopen();
    enterFileMode(app);
    app.openMediaSource();

    app.sendControl({ type: 'play' });
    app.sendControl({ type: 'pause' });
    const playCallsBeforeChunk = app.playCalls;
    app.sendBinary();

    assert.equal(app.video.paused, true);
    assert.equal(app.playCalls, playCallsBeforeChunk);
});

test('stale sourceopen cannot mutate a replacement pipeline', () => {
    const app = createTvRuntime();
    const oldMediaSource = app.currentMediaSource;
    app.sendControl({ type: 'reset', mode: 'file', autoPlay: false });
    const replacement = app.currentMediaSource;

    app.openMediaSource(oldMediaSource);

    assert.equal(replacement.addSourceBufferCalls, 0);
    assert.doesNotMatch(app.elements.connectStatusText.textContent, /ERROR/);
});

test('receiver closes and reconnects instead of growing an unbounded segment queue', () => {
    const app = createTvRuntime();
    app.socket.onopen();
    enterFileMode(app);
    const sourceBuffer = app.openMediaSource();
    sourceBuffer.updating = true;

    for (let index = 0; index < 40; index += 1) app.sendBinary();

    assert.deepEqual(app.socket.closed, {
        code: 1013,
        reason: 'Receiver media queue overflow'
    });
});

test('receiver retains only ten seconds of played media history', () => {
    const app = createTvRuntime();
    app.socket.onopen();
    const sourceBuffer = app.openMediaSource();
    app.video.currentTime = 20;

    app.intervals[0]();

    assert.deepEqual(sourceBuffer.removed, [[0, 10]]);
});

test('sync telemetry tolerates a socket closing during send', () => {
    const app = createTvRuntime();
    app.socket.onopen();
    app.socket.throwOnSend = true;

    assert.doesNotThrow(() => app.intervals[1]());
});

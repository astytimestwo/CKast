const assert = require('assert');
const test = require('node:test');

const {
    normalizeFixedLatencyOptions,
    calculateFixedLatencyControl,
    chooseFixedLatencyAction
} = require('../lib/fixedLatency');

test('normalizes fixed latency options with safe bounds', () => {
    assert.deepEqual(normalizeFixedLatencyOptions({
        enabled: true,
        targetSeconds: 2.5,
        minBufferSeconds: 1.25
    }), {
        enabled: true,
        targetSeconds: 2.5,
        minBufferSeconds: 1.25
    });

    assert.equal(normalizeFixedLatencyOptions({ targetSeconds: 99 }).targetSeconds, 8);
    assert.equal(normalizeFixedLatencyOptions({ targetSeconds: 0.1 }).targetSeconds, 0.5);
});

test('waits until enough buffered video exists before first playback', () => {
    const action = chooseFixedLatencyAction({
        enabled: true,
        hasStarted: false,
        currentLagSeconds: 0.4,
        bufferAheadSeconds: 1.8,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        paused: true
    });

    assert.deepEqual(action, {
        type: 'wait',
        playbackRate: 1,
        reason: 'buffering'
    });
});

test('translates total TV lag target into the TV buffer target', () => {
    const control = calculateFixedLatencyControl({
        options: {
            enabled: true,
            targetSeconds: 2.5
        },
        actualLagSeconds: 3.58,
        bufferAheadSeconds: 2.65
    });

    assert.deepEqual(control, {
        enabled: true,
        targetSeconds: 1.57,
        minBufferSeconds: 1.32,
        targetTotalSeconds: 2.5,
        liveEdgeLagSeconds: 0.93,
        actualLagSeconds: 3.58,
        bufferAheadSeconds: 2.65
    });
});

test('falls back to requested total lag before live measurements exist', () => {
    const control = calculateFixedLatencyControl({
        options: {
            enabled: true,
            targetSeconds: 3.5
        }
    });

    assert.equal(control.targetSeconds, 3.5);
    assert.equal(control.targetTotalSeconds, 3.5);
    assert.equal(control.liveEdgeLagSeconds, null);
});

test('missing fixed-latency measurements are not coerced to zero', () => {
    const control = calculateFixedLatencyControl({
        options: {
            enabled: true,
            targetSeconds: 2.5
        },
        actualLagSeconds: 3,
        bufferAheadSeconds: null
    });

    assert.equal(control.liveEdgeLagSeconds, null);
    assert.equal(control.bufferAheadSeconds, null);
    assert.equal(control.targetSeconds, 2.5);
});

test('keeps a small buffer when natural lag already exceeds target', () => {
    const control = calculateFixedLatencyControl({
        options: {
            enabled: true,
            targetSeconds: 1.5
        },
        actualLagSeconds: 2.2,
        bufferAheadSeconds: 0.55
    });

    assert.equal(control.targetSeconds, 0.35);
    assert.equal(control.minBufferSeconds, 0.25);
    assert.equal(control.liveEdgeLagSeconds, 1.65);
});

test('pins playhead to buffered edge when buffer is far above target', () => {
    const action = chooseFixedLatencyAction({
        enabled: true,
        hasStarted: true,
        currentLagSeconds: 3.58,
        bufferAheadSeconds: 2.65,
        targetSeconds: 1.57,
        minBufferSeconds: 1.32,
        paused: false,
        currentTimeSeconds: 20,
        bufferedEndSeconds: 22.65
    });

    assert.deepEqual(action, {
        type: 'seek',
        playbackRate: 1,
        targetTimeSeconds: 21.08,
        reason: 'pin_to_buffer_edge'
    });
});

test('starts playback once target latency and safety buffer are available', () => {
    const action = chooseFixedLatencyAction({
        enabled: true,
        hasStarted: false,
        currentLagSeconds: 2.55,
        bufferAheadSeconds: 2.6,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        paused: true
    });

    assert.deepEqual(action, {
        type: 'play',
        playbackRate: 1,
        reason: 'target_ready'
    });
});

test('gently corrects small fixed-latency drift with playback rate', () => {
    assert.deepEqual(chooseFixedLatencyAction({
        enabled: true,
        hasStarted: true,
        currentLagSeconds: 2.0,
        bufferAheadSeconds: 3,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        paused: false
    }), {
        type: 'rate',
        playbackRate: 0.97,
        reason: 'too_close'
    });

    assert.deepEqual(chooseFixedLatencyAction({
        enabled: true,
        hasStarted: true,
        currentLagSeconds: 3.1,
        bufferAheadSeconds: 1.5,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        paused: false
    }), {
        type: 'rate',
        playbackRate: 1.04,
        reason: 'too_far'
    });
});

test('seeks when fixed-latency drift is too large for rate correction', () => {
    const action = chooseFixedLatencyAction({
        enabled: true,
        hasStarted: true,
        currentLagSeconds: 5.2,
        bufferAheadSeconds: 4,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        paused: false,
        currentTimeSeconds: 20
    });

    assert.deepEqual(action, {
        type: 'seek',
        playbackRate: 1,
        targetTimeSeconds: 22.7,
        reason: 'far_behind'
    });
});

const assert = require('assert');
const test = require('node:test');

const {
    calculateMirrorLagSeconds,
    calculateAudioDelaySeconds
} = require('../lib/mirrorSync');

test('calculates mirrored TV lag from capture elapsed and TV elapsed', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: 1000,
        nowMs: 8500,
        tvBaseTimeSeconds: 20,
        tvCurrentTimeSeconds: 25.25
    });

    assert.equal(lag, 2.25);
});

test('does not report negative mirrored TV lag', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: 1000,
        nowMs: 3000,
        tvBaseTimeSeconds: 10,
        tvCurrentTimeSeconds: 15
    });

    assert.equal(lag, 0);
});

test('does not estimate lag when capture baseline is missing', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: null,
        nowMs: 3000,
        tvBaseTimeSeconds: 10,
        tvCurrentTimeSeconds: 11
    });

    assert.equal(lag, null);
});

test('combines measured lag with manual trim and clamps audio delay', () => {
    assert.equal(calculateAudioDelaySeconds(1.234, 0.1), 1.334);
    assert.equal(calculateAudioDelaySeconds(99, 0), 10);
    assert.equal(calculateAudioDelaySeconds(-2, -1), -2);
});

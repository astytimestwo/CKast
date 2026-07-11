const assert = require('assert');
const test = require('node:test');

const {
    calculateMirrorLagSeconds,
    calculateAudioDelaySeconds
} = require('../lib/mirrorSync');

test('calculates mirrored TV lag from one shared media timeline', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: 0,
        nowMs: 10000,
        tvCurrentTimeSeconds: 9
    });

    assert.equal(lag, 1);
});

test('does not report negative mirrored TV lag', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: 1000,
        nowMs: 3000,
        tvCurrentTimeSeconds: 5
    });

    assert.equal(lag, 0);
});

test('does not estimate lag when capture baseline is missing', () => {
    const lag = calculateMirrorLagSeconds({
        captureStartedAtMs: null,
        nowMs: 3000,
        tvCurrentTimeSeconds: 11
    });

    assert.equal(lag, null);
});

test('combines measured lag with manual trim and clamps audio delay', () => {
    assert.equal(calculateAudioDelaySeconds(1.234, 0.1), 1.334);
    assert.equal(calculateAudioDelaySeconds(99, 0), 10);
    assert.equal(calculateAudioDelaySeconds(-2, -1), -2);
});

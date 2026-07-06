const assert = require('assert');
const test = require('node:test');

const {
    calculateFileSyncState,
    chooseAudioFollowAction
} = require('../lib/fileSync');

test('maps TV playback time to absolute file timestamp', () => {
    const state = calculateFileSyncState({
        streamStartTimeSeconds: 120,
        tvCurrentTimeSeconds: 12.345,
        playerTimeSeconds: 131.9,
        manualVideoOffsetSeconds: 0
    });

    assert.deepEqual(state, {
        canSync: true,
        tvFileTimeSeconds: 132.345,
        targetPlayerTimeSeconds: 132.345,
        playerTimeSeconds: 131.9,
        driftSeconds: 0.445,
        manualVideoOffsetSeconds: 0
    });
});

test('subtracts manual video offset from MPV seek target', () => {
    const state = calculateFileSyncState({
        streamStartTimeSeconds: 120,
        tvCurrentTimeSeconds: 12,
        playerTimeSeconds: 130,
        manualVideoOffsetSeconds: 0.25
    });

    assert.equal(state.tvFileTimeSeconds, 132);
    assert.equal(state.targetPlayerTimeSeconds, 131.75);
    assert.equal(state.driftSeconds, 1.75);
});

test('returns unsyncable state when timing is missing', () => {
    const state = calculateFileSyncState({
        streamStartTimeSeconds: 120,
        tvCurrentTimeSeconds: null,
        playerTimeSeconds: 131.9
    });

    assert.equal(state.canSync, false);
    assert.equal(state.reason, 'missing_timing');
});

test('seeks MPV audio to TV file timestamp for large drift', () => {
    const action = chooseAudioFollowAction({
        canSync: true,
        tvFileTimeSeconds: 132.345,
        targetPlayerTimeSeconds: 132.345,
        playerTimeSeconds: 130.0,
        driftSeconds: 2.345
    });

    assert.deepEqual(action, {
        type: 'seek',
        targetTimeSeconds: 132.345,
        speed: 1,
        reason: 'audio_far_behind'
    });
});

test('does not correct audio drift when automatic follow is disabled', () => {
    const action = chooseAudioFollowAction({
        canSync: true,
        tvFileTimeSeconds: 132.345,
        targetPlayerTimeSeconds: 132.345,
        playerTimeSeconds: 130.0,
        driftSeconds: 2.345
    }, { enabled: false });

    assert.deepEqual(action, {
        type: 'none',
        speed: 1,
        reason: 'auto_follow_disabled'
    });
});

test('does not correct audio drift after automatic follow window expires', () => {
    const action = chooseAudioFollowAction({
        canSync: true,
        tvFileTimeSeconds: 132.345,
        targetPlayerTimeSeconds: 132.345,
        playerTimeSeconds: 130.0,
        driftSeconds: 2.345
    }, {
        enabled: true,
        nowMs: 20_000,
        armedUntilMs: 10_000
    });

    assert.deepEqual(action, {
        type: 'none',
        speed: 1,
        reason: 'auto_follow_disarmed'
    });
});

test('nudges MPV speed for small drift and returns to normal near target', () => {
    assert.deepEqual(chooseAudioFollowAction({
        canSync: true,
        tvFileTimeSeconds: 132.345,
        playerTimeSeconds: 132.0,
        driftSeconds: 0.345
    }), {
        type: 'speed',
        speed: 1.03,
        reason: 'audio_behind'
    });

    assert.deepEqual(chooseAudioFollowAction({
        canSync: true,
        tvFileTimeSeconds: 132.0,
        playerTimeSeconds: 132.02,
        driftSeconds: -0.02
    }), {
        type: 'speed',
        speed: 1,
        reason: 'audio_synced'
    });
});

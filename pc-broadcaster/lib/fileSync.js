function roundSeconds(value) {
    return Math.round(value * 1000) / 1000;
}

function finiteNumber(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function calculateFileSyncState(input) {
    const state = input || {};
    const streamStartTimeSeconds = finiteNumber(state.streamStartTimeSeconds);
    const tvCurrentTimeSeconds = finiteNumber(state.tvCurrentTimeSeconds);
    const playerTimeSeconds = finiteNumber(state.playerTimeSeconds);
    const manualVideoOffsetSeconds = finiteNumber(state.manualVideoOffsetSeconds) || 0;

    if (
        streamStartTimeSeconds === null ||
        tvCurrentTimeSeconds === null ||
        playerTimeSeconds === null
    ) {
        return {
            canSync: false,
            reason: 'missing_timing'
        };
    }

    const tvFileTimeSeconds = streamStartTimeSeconds + tvCurrentTimeSeconds;
    const targetPlayerTimeSeconds = tvFileTimeSeconds - manualVideoOffsetSeconds;
    const audioTimeSeconds = playerTimeSeconds + manualVideoOffsetSeconds;

    return {
        canSync: true,
        tvFileTimeSeconds: roundSeconds(tvFileTimeSeconds),
        targetPlayerTimeSeconds: roundSeconds(Math.max(0, targetPlayerTimeSeconds)),
        playerTimeSeconds: roundSeconds(playerTimeSeconds),
        driftSeconds: roundSeconds(tvFileTimeSeconds - audioTimeSeconds),
        manualVideoOffsetSeconds: roundSeconds(manualVideoOffsetSeconds)
    };
}

function chooseAudioFollowAction(input, options = {}) {
    if (options.enabled === false) {
        return {
            type: 'none',
            speed: 1,
            reason: 'auto_follow_disabled'
        };
    }
    if (options.armedUntilMs !== undefined) {
        const nowMs = finiteNumber(options.nowMs);
        const armedUntilMs = finiteNumber(options.armedUntilMs);
        if (armedUntilMs === null || (nowMs === null ? Date.now() : nowMs) > armedUntilMs) {
            return {
                type: 'none',
                speed: 1,
                reason: 'auto_follow_disarmed'
            };
        }
    }

    const state = input || {};
    if (!state.canSync) {
        return {
            type: 'none',
            speed: 1,
            reason: state.reason || 'not_syncable'
        };
    }

    const driftSeconds = finiteNumber(state.driftSeconds);
    const targetPlayerTimeSeconds = finiteNumber(
        state.targetPlayerTimeSeconds === undefined ? state.tvFileTimeSeconds : state.targetPlayerTimeSeconds
    );
    if (driftSeconds === null || targetPlayerTimeSeconds === null) {
        return {
            type: 'none',
            speed: 1,
            reason: 'missing_timing'
        };
    }

    if (Math.abs(driftSeconds) >= 0.75) {
        return {
            type: 'seek',
            targetTimeSeconds: roundSeconds(Math.max(0, targetPlayerTimeSeconds)),
            speed: 1,
            reason: driftSeconds > 0 ? 'audio_far_behind' : 'audio_far_ahead'
        };
    }

    if (driftSeconds > 0.08) {
        return {
            type: 'speed',
            speed: 1.03,
            reason: 'audio_behind'
        };
    }

    if (driftSeconds < -0.08) {
        return {
            type: 'speed',
            speed: 0.97,
            reason: 'audio_ahead'
        };
    }

    return {
        type: 'speed',
        speed: 1,
        reason: 'audio_synced'
    };
}

module.exports = {
    calculateFileSyncState,
    chooseAudioFollowAction
};

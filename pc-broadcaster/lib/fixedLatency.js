function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundSeconds(value) {
    return Math.round(value * 1000) / 1000;
}

function normalizeFixedLatencyOptions(input) {
    const options = input || {};
    const targetSeconds = clamp(Number(options.targetSeconds) || 2.5, 0.5, 8);
    const minBufferSeconds = clamp(
        Number(options.minBufferSeconds) || Math.max(0.5, targetSeconds - 0.25),
        0.25,
        8
    );

    return {
        enabled: options.enabled !== false,
        targetSeconds: roundSeconds(targetSeconds),
        minBufferSeconds: roundSeconds(minBufferSeconds)
    };
}

function finiteNumber(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function calculateFixedLatencyControl(input) {
    const state = input || {};
    const options = normalizeFixedLatencyOptions(state.options || state);
    const actualLagSeconds = finiteNumber(state.actualLagSeconds);
    const bufferAheadSeconds = finiteNumber(state.bufferAheadSeconds);

    let liveEdgeLagSeconds = null;
    if (actualLagSeconds !== null && bufferAheadSeconds !== null) {
        liveEdgeLagSeconds = roundSeconds(clamp(actualLagSeconds - bufferAheadSeconds, 0, 8));
    }

    const targetBufferSeconds = liveEdgeLagSeconds === null
        ? options.targetSeconds
        : clamp(options.targetSeconds - liveEdgeLagSeconds, 0.35, 8);
    const minBufferSeconds = clamp(targetBufferSeconds - 0.25, 0.25, targetBufferSeconds);

    return {
        enabled: options.enabled,
        targetSeconds: roundSeconds(targetBufferSeconds),
        minBufferSeconds: roundSeconds(minBufferSeconds),
        targetTotalSeconds: options.targetSeconds,
        liveEdgeLagSeconds,
        actualLagSeconds: actualLagSeconds === null ? null : roundSeconds(actualLagSeconds),
        bufferAheadSeconds: bufferAheadSeconds === null ? null : roundSeconds(bufferAheadSeconds)
    };
}

function chooseFixedLatencyAction(input) {
    const state = input || {};
    const enabled = state.enabled !== false;
    const targetSeconds = Number(state.targetSeconds);
    const minBufferSeconds = Number(state.minBufferSeconds);
    const currentLagSeconds = Number(state.currentLagSeconds);
    const bufferAheadSeconds = Number(state.bufferAheadSeconds);
    const hasStarted = !!state.hasStarted;
    const paused = !!state.paused;

    if (!enabled) {
        return { type: 'disabled', playbackRate: 1, reason: 'disabled' };
    }
    if (
        !Number.isFinite(targetSeconds) ||
        !Number.isFinite(minBufferSeconds) ||
        !Number.isFinite(currentLagSeconds) ||
        !Number.isFinite(bufferAheadSeconds)
    ) {
        return { type: 'wait', playbackRate: 1, reason: 'missing_timing' };
    }

    if (!hasStarted) {
        if (currentLagSeconds >= targetSeconds && bufferAheadSeconds >= minBufferSeconds) {
            return { type: 'play', playbackRate: 1, reason: 'target_ready' };
        }
        return { type: 'wait', playbackRate: 1, reason: 'buffering' };
    }

    const error = currentLagSeconds - targetSeconds;
    const bufferError = bufferAheadSeconds - targetSeconds;
    const bufferedEndSeconds = Number(state.bufferedEndSeconds);
    if (bufferError > 0.35 && Number.isFinite(bufferedEndSeconds)) {
        return {
            type: 'seek',
            playbackRate: 1,
            targetTimeSeconds: roundSeconds(Math.max(0, bufferedEndSeconds - targetSeconds)),
            reason: 'pin_to_buffer_edge'
        };
    }

    if (Math.abs(error) <= 0.18) {
        if (paused) return { type: 'play', playbackRate: 1, reason: 'resume_at_target' };
        return { type: 'rate', playbackRate: 1, reason: 'on_target' };
    }

    if (error > 1.5) {
        const currentTimeSeconds = Number(state.currentTimeSeconds) || 0;
        return {
            type: 'seek',
            playbackRate: 1,
            targetTimeSeconds: roundSeconds(Math.max(0, currentTimeSeconds + error)),
            reason: 'far_behind'
        };
    }

    if (error < -0.85) {
        return { type: 'pause', playbackRate: 1, reason: 'too_close_hold' };
    }

    if (error > 0) {
        return { type: 'rate', playbackRate: 1.04, reason: 'too_far' };
    }

    return { type: 'rate', playbackRate: 0.97, reason: 'too_close' };
}

module.exports = {
    normalizeFixedLatencyOptions,
    calculateFixedLatencyControl,
    chooseFixedLatencyAction
};

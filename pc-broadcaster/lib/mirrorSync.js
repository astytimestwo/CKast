function roundSeconds(value) {
    return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function calculateMirrorLagSeconds(input) {
    if (
        !input ||
        input.captureStartedAtMs === null ||
        input.captureStartedAtMs === undefined ||
        input.nowMs === null ||
        input.nowMs === undefined ||
        input.tvCurrentTimeSeconds === null ||
        input.tvCurrentTimeSeconds === undefined
    ) {
        return null;
    }

    const captureStartedAtMs = Number(input && input.captureStartedAtMs);
    const nowMs = Number(input && input.nowMs);
    const tvCurrentTimeSeconds = Number(input && input.tvCurrentTimeSeconds);

    if (
        !Number.isFinite(captureStartedAtMs) ||
        !Number.isFinite(nowMs) ||
        !Number.isFinite(tvCurrentTimeSeconds) ||
        nowMs < captureStartedAtMs
    ) {
        return null;
    }

    const captureElapsedSeconds = (nowMs - captureStartedAtMs) / 1000;
    return roundSeconds(Math.max(0, captureElapsedSeconds - tvCurrentTimeSeconds));
}

function calculateAudioDelaySeconds(lagSeconds, trimSeconds) {
    const lag = Number(lagSeconds);
    const trim = Number(trimSeconds) || 0;
    if (!Number.isFinite(lag)) return null;
    return roundSeconds(clamp(lag + trim, -2, 10));
}

module.exports = {
    calculateMirrorLagSeconds,
    calculateAudioDelaySeconds
};

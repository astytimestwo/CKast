const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { MpvController, resolveMpvPath } = require('./lib/mpvController');
const { probeMedia, resolveFfprobePath } = require('./lib/mediaProbe');
const { FileVideoStreamer, resolveFfmpegPath } = require('./lib/fileVideoStreamer');
const { DesktopCapture } = require('./lib/desktopCapture');
const { TvSession } = require('./lib/tvSession');
const { FilePlaybackCoordinator } = require('./lib/filePlaybackCoordinator');
const { createShutdown } = require('./lib/shutdown');
const {
    calculateMirrorLagSeconds,
    calculateAudioDelaySeconds
} = require('./lib/mirrorSync');
const {
    normalizeFixedLatencyOptions,
    calculateFixedLatencyControl
} = require('./lib/fixedLatency');
const {
    calculateFileSyncState,
    chooseAudioFollowAction,
    resolveFileStartTime
} = require('./lib/fileSync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const player = new MpvController();
const fileVideo = new FileVideoStreamer();
const desktopCapture = new DesktopCapture();
const tvSession = new TvSession();
const AUTO_AUDIO_FOLLOW_WINDOW_MS = 15000;

function freshState() {
    return {
        tvSyncState: null,
        captureStartedAtMs: null,
        captureTimelineStartedAtMs: null,
        tvCaptureBaseTime: null,
        tvCaptureBaseReceivedAt: null
    };
}

let S = freshState();
let syncResyncing = false;
let lastRateCommandAt = 0;
let lastPlaybackRate = 1;
let lastAudioFollowSpeed = 1;
let lastAudioFollowSeekAt = 0;
let manualVideoOffsetSeconds = 0;
let autoAudioFollowEnabled = true;
let autoAudioFollowArmedUntilMs = 0;
let streamOptions = {
    bitrateKbps: 16000,
    fitMode: 'contain',
    subtitleStreamIndex: -1,
    externalSubtitlePath: '',
    subtitleDelay: 0,
    subtitleScale: 1,
    subtitlesEnabled: false
};
let fixedLatencyOptions = normalizeFixedLatencyOptions({
    enabled: true,
    targetSeconds: 2.5
});
let mirrorAudioTrimSeconds = 0;
let lastFixedLatencyControl = null;
let lastFixedLatencyControlSentAt = 0;
const filePlayback = new FilePlaybackCoordinator({
    player,
    fileVideo,
    tvSession,
    getStreamOptions: () => streamOptions,
    sendSegment: (chunk) => sendTvSegment(chunk, 'file'),
    sendControl: sendTvControl,
    resetTv: resetTvForFilePlayback,
    resetStats: () => resetSegmentStats('file'),
    onResume: () => {
        lastAudioFollowSpeed = 1;
        lastPlaybackRate = 1;
        armAutoAudioFollow(0);
    }
});

function resetSegmentStats(kind) {
    tvSession.resetSegmentStats();
}

function reportError(label, err) {
    const detail = err && (err.stack || err.message) ? (err.stack || err.message) : err;
    console.error(`[${label}]`, detail || 'Unknown error');
}

function getMirrorSyncState(nowMs = Date.now()) {
    const captureStartedAtMs = S.captureTimelineStartedAtMs || S.captureStartedAtMs;
    const tvSyncState = S.tvSyncState || {};
    const lagSeconds = calculateMirrorLagSeconds({
        captureStartedAtMs,
        nowMs,
        tvBaseTimeSeconds: S.tvCaptureBaseTime,
        tvCurrentTimeSeconds: tvSyncState.currentTime
    });
    const recommendedAudioDelaySeconds = calculateAudioDelaySeconds(lagSeconds, mirrorAudioTrimSeconds);
    const playerStatus = player.getStatus();

    return {
        canEstimate: Number.isFinite(lagSeconds),
        lagSeconds,
        trimSeconds: mirrorAudioTrimSeconds,
        recommendedAudioDelaySeconds,
        currentAudioDelaySeconds: Number.isFinite(playerStatus.audioDelay) ? playerStatus.audioDelay : 0,
        captureRunning: desktopCapture.getStatus().active,
        captureStartedAtMs,
        tvBaseTimeSeconds: S.tvCaptureBaseTime,
        tvCurrentTimeSeconds: Number.isFinite(tvSyncState.currentTime) ? tvSyncState.currentTime : null,
        tvBufferedEnd: Number.isFinite(tvSyncState.bufferedEnd) ? tvSyncState.bufferedEnd : null,
        tvReadyState: tvSyncState.readyState,
        lastTvSyncStateAt: tvSyncState.receivedAt || null
    };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

player.on('error', (err) => {
    reportError('mpv_error', err);
});

fileVideo.on('error', (err) => {
    reportError('file_video_error', err);
});

fileVideo.on('start', (event) => {
    resetSegmentStats('file');
});

desktopCapture.on('initialized', () => {
    S.captureTimelineStartedAtMs = Date.now();
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
});

desktopCapture.on('error', (err) => {
    reportError('desktop_ffmpeg_error', err);
});

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((err) => {
            reportError(`${req.method} ${req.path}`, err);
            res.status(400).json({
                success: false,
                error: err.message
            });
        });
    };
}

function isTvConnected() {
    return tvSession.isConnected();
}

function sendTvControl(payload) {
    return tvSession.sendControl(payload);
}

function sendTvSegment(chunk, kind = 'file') {
    return tvSession.sendSegment(chunk, kind);
}

function clearSyncResume() {
    tvSession.clearReadiness();
}

function armAutoAudioFollow(delaySeconds = 0) {
    if (!autoAudioFollowEnabled) {
        autoAudioFollowArmedUntilMs = 0;
        return;
    }

    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    autoAudioFollowArmedUntilMs = Date.now() + delayMs + AUTO_AUDIO_FOLLOW_WINDOW_MS;
}

function disarmAutoAudioFollow() {
    autoAudioFollowArmedUntilMs = 0;
}

function isAutoAudioFollowArmed(nowMs = Date.now()) {
    return autoAudioFollowEnabled && nowMs <= autoAudioFollowArmedUntilMs;
}

function normalizeStreamOptions(input) {
    const next = { ...streamOptions };
    if (!input) return next;

    if (input.bitrateKbps !== undefined) {
        next.bitrateKbps = Math.max(2000, Math.min(40000, Number(input.bitrateKbps) || 16000));
    }
    if (input.fitMode === 'contain' || input.fitMode === 'cover' || input.fitMode === 'fill') {
        next.fitMode = input.fitMode;
    }
    if (input.subtitleStreamIndex !== undefined) {
        next.subtitleStreamIndex = Number(input.subtitleStreamIndex);
        if (!Number.isInteger(next.subtitleStreamIndex)) next.subtitleStreamIndex = -1;
    }
    if (input.externalSubtitlePath !== undefined) {
        next.externalSubtitlePath = String(input.externalSubtitlePath || '').trim();
    }
    if (input.subtitleDelay !== undefined) {
        next.subtitleDelay = Number(input.subtitleDelay) || 0;
    }
    if (input.subtitleScale !== undefined) {
        next.subtitleScale = Math.max(0.5, Math.min(3, Number(input.subtitleScale) || 1));
    }
    if (input.subtitlesEnabled !== undefined) {
        next.subtitlesEnabled = !!input.subtitlesEnabled;
    }

    return next;
}

function applyStreamOptions(input) {
    streamOptions = normalizeStreamOptions(input);
    sendTvControl({ type: 'fit', mode: streamOptions.fitMode });
    return streamOptions;
}

function applyFixedLatencyOptions(input) {
    fixedLatencyOptions = normalizeFixedLatencyOptions({
        ...fixedLatencyOptions,
        ...(input || {})
    });
    sendFixedLatencyControl({ force: true, reason: 'api_update' });
    return getFixedLatencyState();
}

function getTvBufferAheadSeconds() {
    const tvSyncState = S.tvSyncState || {};
    const tvFixedLatency = tvSyncState.fixedLatency || {};
    const fixedBufferAhead = Number(tvFixedLatency.bufferAheadSeconds);
    if (Number.isFinite(fixedBufferAhead)) return Math.max(0, fixedBufferAhead);

    const bufferedEnd = Number(tvSyncState.bufferedEnd);
    const currentTime = Number(tvSyncState.currentTime);
    if (Number.isFinite(bufferedEnd) && Number.isFinite(currentTime)) {
        return Math.max(0, bufferedEnd - currentTime);
    }

    return null;
}

function getFixedLatencyControlOptions() {
    const mirrorSync = getMirrorSyncState();
    return calculateFixedLatencyControl({
        options: fixedLatencyOptions,
        actualLagSeconds: mirrorSync.lagSeconds,
        bufferAheadSeconds: getTvBufferAheadSeconds()
    });
}

function getFixedLatencyState() {
    return {
        ...fixedLatencyOptions,
        targetTotalSeconds: fixedLatencyOptions.targetSeconds,
        control: getFixedLatencyControlOptions(),
        tv: S.tvSyncState && S.tvSyncState.fixedLatency ? S.tvSyncState.fixedLatency : null
    };
}

function shouldSendFixedLatencyControl(control, force) {
    if (force || !lastFixedLatencyControl) return true;

    const now = Date.now();
    if (now - lastFixedLatencyControlSentAt < 1000) return false;

    return (
        control.enabled !== lastFixedLatencyControl.enabled ||
        Math.abs(control.targetSeconds - lastFixedLatencyControl.targetSeconds) >= 0.15 ||
        Math.abs(control.minBufferSeconds - lastFixedLatencyControl.minBufferSeconds) >= 0.15 ||
        now - lastFixedLatencyControlSentAt >= 5000
    );
}

function sendFixedLatencyControl(options = {}) {
    const control = getFixedLatencyControlOptions();
    if (!shouldSendFixedLatencyControl(control, !!options.force)) return false;

    const sent = sendTvControl({
        type: 'fixedLatency',
        reason: options.reason || 'update',
        options: {
            enabled: control.enabled,
            targetSeconds: control.targetSeconds,
            minBufferSeconds: control.minBufferSeconds,
            targetTotalSeconds: control.targetTotalSeconds,
            liveEdgeLagSeconds: control.liveEdgeLagSeconds
        }
    });

    if (sent) {
        lastFixedLatencyControl = control;
        lastFixedLatencyControlSentAt = Date.now();
    }

    return sent;
}

function sendFilePlaybackTvControls(reason) {
    sendTvControl({
        type: 'fixedLatency',
        reason: reason || 'file_playback',
        mode: 'file',
        options: {
            enabled: false,
            targetSeconds: 0.5,
            minBufferSeconds: 0.25,
            targetTotalSeconds: 0.5
        }
    });
    sendTvControl({ type: 'setPlaybackRate', rate: 1 });
}

function resetTvForDesktopCapture() {
    sendTvControl({
        type: 'reset',
        mode: 'desktop',
        autoPlay: !fixedLatencyOptions.enabled,
        generation: tvSession.generation,
        reason: 'desktop_capture_start'
    });
    sendFixedLatencyControl({ force: true, reason: 'desktop_capture_start' });
}

function resetTvForFilePlayback(reason) {
    sendFilePlaybackTvControls(reason || 'file_playback');
    sendTvControl({
        type: 'reset',
        mode: 'file',
        autoPlay: false,
        generation: tvSession.generation,
        reason: reason || 'file_playback'
    });
    sendTvControl({ type: 'fit', mode: streamOptions.fitMode });
}

function clearTvTimingState() {
    S.tvSyncState = null;
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
}

function sendCurrentTvHandshake() {
    const mode = tvSession.mode;
    sendTvControl({
        type: 'reset',
        mode,
        autoPlay: false,
        generation: tvSession.generation,
        reason: 'tv_connected'
    });

    if (mode === 'desktop') {
        sendFixedLatencyControl({ force: true, reason: 'tv_connected' });
        if (desktopCapture.initSegment) sendTvSegment(desktopCapture.initSegment, 'desktop');
    } else if (mode === 'file') {
        sendFilePlaybackTvControls('tv_connected');
        sendTvControl({ type: 'fit', mode: streamOptions.fitMode });
        if (fileVideo.initSegment) sendTvSegment(fileVideo.initSegment, 'file');
    }
}

async function startTvVideo(options) {
    if (!isTvConnected()) {
        throw new Error('TV is not connected.');
    }

    const status = await player.refreshCoreProperties();
    if (!status.loaded || !status.filePath) {
        throw new Error('Open a media file before starting TV video.');
    }

    const delaySeconds = Number(options && options.delaySeconds) || 5;
    applyStreamOptions(options);
    const startTime = resolveFileStartTime(
        options && options.startTime,
        status.timePos,
        manualVideoOffsetSeconds
    );

    stopCapture();
    clearTvTimingState();
    lastAudioFollowSpeed = 1;
    await filePlayback.restart({
        filePath: status.filePath,
        startTime,
        resume: !!(options && options.autoPlay),
        targetBufferSeconds: delaySeconds,
        reason: 'file_playback_start'
    });

    return getPlayerBundle();
}

async function seekPlayerAndTv(targetTime, shouldResume) {
    clearSyncResume();
    await player.pause();
    await player.setSpeed(1);
    lastAudioFollowSpeed = 1;
    if (tvSession.mode === 'file') {
        sendFilePlaybackTvControls('file_seek');
        sendTvControl({ type: 'pause' });
    }
    const playerStatus = await player.seek(targetTime);

    if (tvSession.mode === 'file' && fileVideo.getStatus().filePath) {
        await filePlayback.restart({
            startTime: Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds),
            resume: shouldResume,
            targetBufferSeconds: 5,
            reason: 'file_seek'
        });
    } else if (shouldResume) {
        await player.play();
    }

    return getPlayerBundle();
}

async function handleTvSyncState(tvState) {
    const now = Date.now();
    S.tvSyncState = {
        ...tvState,
        receivedAt: now
    };
    updateMirrorSyncFromTvSyncState(tvState);
    if (desktopCapture.getStatus().active && fixedLatencyOptions.enabled) {
        sendFixedLatencyControl({ reason: 'sync_state' });
    }

    await filePlayback.resumeIfReady(S.tvSyncState);

    const streamStatus = fileVideo.getStatus();
    const playerStatus = player.getStatus();
    const streamCanSync = streamStatus.playbackAvailable;
    if (!streamCanSync || !playerStatus.loaded || playerStatus.paused) return;
    if (!Number.isFinite(tvState.currentTime)) return;

    if (filePlayback.initialAlignmentPending) {
        filePlayback.initialAlignmentPending = false;
        const targetTime = tvState.currentTime + streamStatus.streamStartTime;
        player.seek(targetTime).catch((err) => reportError('initial_alignment_seek_failed', err));
        return;
    }

    const fileSync = calculateFileSyncState({
        streamStartTimeSeconds: streamStatus.streamStartTime,
        tvCurrentTimeSeconds: tvState.currentTime,
        playerTimeSeconds: playerStatus.timePos,
        manualVideoOffsetSeconds
    });
    const drift = fileSync.canSync ? fileSync.driftSeconds : null;
    S.tvSyncState.drift = drift;
    S.tvSyncState.fileSync = fileSync;

    if (!fileSync.canSync) return;

    const action = chooseAudioFollowAction(fileSync, {
        enabled: autoAudioFollowEnabled,
        armedUntilMs: autoAudioFollowArmedUntilMs,
        nowMs: now
    });

    if (action.type === 'none') {
        if (action.reason === 'auto_follow_disarmed' && lastAudioFollowSpeed !== 1) {
            lastAudioFollowSpeed = 1;
            lastPlaybackRate = 1;
            await player.setSpeed(1);
        }
        return;
    }

    if (action.type === 'seek' && !syncResyncing && now - lastAudioFollowSeekAt >= 1000) {
        syncResyncing = true;
        lastAudioFollowSeekAt = now;
        try {
            await player.seek(action.targetTimeSeconds);
            await player.setSpeed(1);
            lastAudioFollowSpeed = 1;
            lastPlaybackRate = 1;
        } catch (err) {
            reportError('file_audio_follow_seek_failed', err);
        } finally {
            setTimeout(() => { syncResyncing = false; }, 500);
        }
        return;
    }

    if (now - lastRateCommandAt < 750) return;

    if (action.type === 'speed' && action.speed !== lastAudioFollowSpeed) {
        lastAudioFollowSpeed = action.speed;
        lastPlaybackRate = action.speed;
        lastRateCommandAt = now;
        await player.setSpeed(action.speed);
    }
}

function updateMirrorSyncFromTvSyncState(tvState) {
    if (!desktopCapture.getStatus().active || !S.captureTimelineStartedAtMs) return;
    if (!Number.isFinite(tvState.currentTime)) return;

    if (!Number.isFinite(S.tvCaptureBaseTime)) {
        S.tvCaptureBaseTime = tvState.currentTime;
        S.tvCaptureBaseReceivedAt = Date.now();
    }

    const state = getMirrorSyncState();
    if (!state.canEstimate) return;

    S.tvSyncState.mirrorLag = state.lagSeconds;
}

function getPlayerBundle() {
    return {
        player: player.getStatus(),
        tvVideo: fileVideo.getStatus(),
        tvSyncState: S.tvSyncState,
        sync: {
            pendingResume: !!tvSession.pendingReadiness,
            targetDelaySeconds: tvSession.pendingReadiness
                ? tvSession.pendingReadiness.targetBufferSeconds
                : 5,
            readinessTimedOut: filePlayback.getStatus().readinessTimedOut,
            lastPlaybackRate,
            lastAudioFollowSpeed,
            manualVideoOffsetSeconds,
            autoAudioFollowEnabled,
            autoAudioFollowArmed: isAutoAudioFollowArmed()
        },
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState(),
        tvSession: tvSession.getStatus()
    };
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

wss.on('connection', (ws, req) => {
    if (req.url !== '/tv') {
        ws.close(1008, 'Unsupported websocket path');
        return;
    }

    tvSession.replaceSocket(ws);
    clearTvTimingState();
    if (tvSession.mode === 'desktop') {
        S.captureTimelineStartedAtMs = Date.now();
    }
    const fileStatus = fileVideo.getStatus();
    const playerStatus = player.getStatus();
    if (tvSession.mode === 'file' && fileStatus.filePath && playerStatus.loaded) {
        filePlayback.restart({
            startTime: Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds),
            resume: playerStatus.paused === false,
            targetBufferSeconds: 5,
            reason: 'tv_reconnected'
        }).catch((err) => reportError('file_reconnect_restart_failed', err));
    } else {
        sendCurrentTvHandshake();
    }

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            return;
        }

        try {
            const payload = JSON.parse(message.toString('utf8'));
            if (payload.type === 'sync_state') {
                if (!tvSession.acceptTelemetry(ws, payload)) return;
                handleTvSyncState(tvSession.telemetry).catch((err) => {
                    reportError('tv_sync_state_handling_failed', err);
                });
            }
        } catch (err) {
            reportError('tv_message_invalid', err);
        }
    });

    ws.on('close', () => {
        tvSession.detachSocket(ws);
    });

    ws.on('error', (err) => reportError('tv_socket_error', err));
});

function stopCapture(options = {}) {
    desktopCapture.stop();
    S.captureStartedAtMs = null;
    S.captureTimelineStartedAtMs = null;
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
    if (options.notifyTv && tvSession.mode === 'desktop') {
        sendTvControl({ type: 'stop' });
        tvSession.beginMode('idle');
        S.tvSyncState = null;
    }
}

function startCapture() {
    clearSyncResume();
    disarmAutoAudioFollow();
    fileVideo.stop();
    stopCapture();
    tvSession.beginMode('desktop');
    clearTvTimingState();
    resetSegmentStats('desktop');
    S.captureStartedAtMs = Date.now();
    S.captureTimelineStartedAtMs = null;
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
    resetTvForDesktopCapture();

    desktopCapture.start((chunk) => sendTvSegment(chunk, 'desktop'));
}

app.post('/start', (req, res) => {
    startCapture();
    res.json({ success: true, message: 'Capture started' });
});

app.post('/stop', (req, res) => {
    stopCapture({ notifyTv: true });
    res.json({ success: true, message: 'Capture stopped' });
});

app.post('/api/fixed-latency', asyncRoute(async (req, res) => {
    const fixedLatency = applyFixedLatencyOptions(req.body || {});
    res.json({
        success: true,
        fixedLatency,
        mirrorSync: getMirrorSyncState(),
        tvSyncState: S.tvSyncState
    });
}));

app.post('/api/player/open', asyncRoute(async (req, res) => {
    const filePath = req.body && req.body.filePath;
    const media = await probeMedia(filePath);
    if (tvSession.mode === 'file') {
        await filePlayback.stop('open_new_file');
        S.tvSyncState = null;
    }
    const status = await player.open(media.filePath);

    res.json({
        success: true,
        media,
        player: status
    });
}));

app.post('/api/player/play', asyncRoute(async (req, res) => {
    if (tvSession.mode === 'file' && fileVideo.getStatus().playbackAvailable) {
        sendFilePlaybackTvControls('file_player_play');
        sendTvControl({ type: 'play' });
    }
    const status = await player.play();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/pause', asyncRoute(async (req, res) => {
    clearSyncResume();
    disarmAutoAudioFollow();
    if (tvSession.mode === 'file') sendTvControl({ type: 'pause' });
    if (player.getStatus().loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
    }
    const status = await player.pause();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/seek', asyncRoute(async (req, res) => {
    const wasPlaying = !!(req.body && req.body.autoPlay) || player.getStatus().paused === false;
    const bundle = await seekPlayerAndTv(req.body && req.body.time, wasPlaying);
    res.json({ success: true, ...bundle });
}));

app.post('/api/player/volume', asyncRoute(async (req, res) => {
    const status = await player.setVolume(req.body && req.body.volume);
    res.json({ success: true, player: status });
}));

app.post('/api/player/audio-track', asyncRoute(async (req, res) => {
    const status = await player.setAudioTrack(req.body && req.body.audioTrackId);
    res.json({ success: true, player: status });
}));

app.post('/api/player/audio-delay', asyncRoute(async (req, res) => {
    const delaySeconds = Number(req.body && req.body.delaySeconds);
    const status = await player.setAudioDelay(delaySeconds);
    res.json({
        success: true,
        player: status,
        mirrorSync: getMirrorSyncState()
    });
}));

app.post('/api/player/audio-delay/nudge', asyncRoute(async (req, res) => {
    const deltaSeconds = Number(req.body && req.body.deltaSeconds) || 0;
    const currentDelay = Number(player.getStatus().audioDelay) || 0;
    const nextDelay = calculateAudioDelaySeconds(currentDelay, deltaSeconds);
    const status = await player.setAudioDelay(nextDelay);
    res.json({
        success: true,
        player: status,
        mirrorSync: getMirrorSyncState()
    });
}));

app.post('/api/player/mirror/sync-audio', asyncRoute(async (req, res) => {
    if (req.body && req.body.trimSeconds !== undefined) {
        mirrorAudioTrimSeconds = Math.max(-2, Math.min(2, Number(req.body.trimSeconds) || 0));
    }

    const mirrorSync = getMirrorSyncState();
    if (!mirrorSync.canEstimate || !Number.isFinite(mirrorSync.recommendedAudioDelaySeconds)) {
        throw new Error('Start desktop capture and wait for TV sync timing before syncing audio.');
    }

    const status = await player.setAudioDelay(mirrorSync.recommendedAudioDelaySeconds);
    res.json({
        success: true,
        player: status,
        mirrorSync: getMirrorSyncState()
    });
}));

app.post('/api/player/stop', asyncRoute(async (req, res) => {
    clearSyncResume();
    disarmAutoAudioFollow();
    if (tvSession.mode === 'file') {
        await filePlayback.stop('player_stop');
        S.tvSyncState = null;
    } else {
        fileVideo.stop();
    }
    const status = await player.stop();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/tv/start', asyncRoute(async (req, res) => {
    const bundle = await startTvVideo({
        autoPlay: !!(req.body && req.body.autoPlay),
        delaySeconds: req.body && req.body.delaySeconds,
        ...(req.body || {})
    });

    res.json({ success: true, ...bundle });
}));

app.post('/api/player/tv/stop', asyncRoute(async (req, res) => {
    clearSyncResume();
    disarmAutoAudioFollow();
    if (tvSession.mode === 'file') {
        await filePlayback.stop('tv_video_stop');
        S.tvSyncState = null;
    } else {
        fileVideo.stop();
    }
    const tvVideo = fileVideo.getStatus();
    res.json({ success: true, tvVideo, player: player.getStatus() });
}));

app.post('/api/player/tv/resync', asyncRoute(async (req, res) => {
    const status = await player.refreshCoreProperties();
    const bundle = await seekPlayerAndTv(status.timePos, status.paused === false);
    res.json({ success: true, ...bundle });
}));

app.post('/api/player/tv/options', asyncRoute(async (req, res) => {
    applyStreamOptions(req.body || {});

    const tvStatus = fileVideo.getStatus();
    const playerStatus = await player.refreshCoreProperties();
    if (tvSession.mode === 'file' && tvStatus.playbackAvailable && playerStatus.loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
        await filePlayback.restart({
            startTime: Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds),
            resume: playerStatus.paused === false,
            targetBufferSeconds: 5,
            reason: 'file_options_restart'
        });
    }

    res.json({ success: true, ...getPlayerBundle(), streamOptions });
}));

app.post('/api/player/tv/fit', asyncRoute(async (req, res) => {
    applyStreamOptions({ fitMode: req.body && req.body.fitMode });
    res.json({ success: true, streamOptions, ...getPlayerBundle() });
}));

app.post('/api/player/tv/nudge', asyncRoute(async (req, res) => {
    const delta = Number(req.body && req.body.deltaSeconds) || 0;
    manualVideoOffsetSeconds = Math.max(-10, Math.min(10, manualVideoOffsetSeconds + delta));

    const tvStatus = fileVideo.getStatus();
    const playerStatus = await player.refreshCoreProperties();
    if (tvSession.mode === 'file' && tvStatus.playbackAvailable && playerStatus.loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
        await filePlayback.restart({
            startTime: Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds),
            resume: playerStatus.paused === false,
            targetBufferSeconds: 5,
            reason: 'file_nudge_restart'
        });
    }

    res.json({ success: true, ...getPlayerBundle(), streamOptions });
}));

app.post('/api/player/sync-options', asyncRoute(async (req, res) => {
    autoAudioFollowEnabled = !!(req.body && req.body.autoAudioFollowEnabled);
    if (autoAudioFollowEnabled) {
        armAutoAudioFollow(0);
    } else {
        disarmAutoAudioFollow();
    }
    if (!autoAudioFollowEnabled && player.getStatus().loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
        lastPlaybackRate = 1;
    }
    res.json({ success: true, ...getPlayerBundle() });
}));

app.get('/api/player/status', asyncRoute(async (req, res) => {
    const status = await player.refreshCoreProperties();
    res.json({
        success: true,
        player: status,
        tvVideo: fileVideo.getStatus(),
        tvSyncState: S.tvSyncState,
        sync: {
            pendingResume: !!tvSession.pendingReadiness,
            targetDelaySeconds: tvSession.pendingReadiness
                ? tvSession.pendingReadiness.targetBufferSeconds
                : 5,
            readinessTimedOut: filePlayback.getStatus().readinessTimedOut,
            lastPlaybackRate,
            lastAudioFollowSpeed,
            manualVideoOffsetSeconds,
            autoAudioFollowEnabled,
            autoAudioFollowArmed: isAutoAudioFollowArmed()
        },
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState(),
        streamOptions,
        tvSession: tvSession.getStatus(),
        dependencies: {
            mpv: resolveMpvPath(),
            ffprobe: resolveFfprobePath(),
            ffmpeg: resolveFfmpegPath()
        }
    });
}));

app.get('/status', (req, res) => {
    res.json({
        running: desktopCapture.getStatus().active,
        tvConnected: tvSession.isConnected(),
        player: player.getStatus(),
        tvVideo: fileVideo.getStatus(),
        tvSyncState: S.tvSyncState,
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState(),
        tvSession: tvSession.getStatus(),
        sync: {
            pendingResume: !!tvSession.pendingReadiness,
            targetDelaySeconds: tvSession.pendingReadiness
                ? tvSession.pendingReadiness.targetBufferSeconds
                : 5,
            readinessTimedOut: filePlayback.getStatus().readinessTimedOut,
            lastPlaybackRate,
            lastAudioFollowSpeed,
            manualVideoOffsetSeconds,
            autoAudioFollowEnabled,
            autoAudioFollowArmed: isAutoAudioFollowArmed()
        }
    });
});

const PORT = process.env.PORT || 8080;
const shutdown = createShutdown({
    desktopCapture,
    fileVideo,
    player,
    tvSession,
    httpServer: server
});

function handleShutdownSignal(signal) {
    shutdown(signal)
        .then(() => process.exit(0))
        .catch((err) => {
            reportError('shutdown_failed', err);
            process.exit(1);
        });
}

process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));

server.once('error', (err) => {
    reportError('server_error', err);
    shutdown('server_error').catch((shutdownError) => {
        reportError('shutdown_after_server_error_failed', shutdownError);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`Open http://localhost:${PORT} in Chrome to start streaming`);
});

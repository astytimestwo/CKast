const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');
const { MpvController, resolveMpvPath } = require('./lib/mpvController');
const { probeMedia, resolveFfprobePath } = require('./lib/mediaProbe');
const { FileVideoStreamer, resolveFfmpegPath } = require('./lib/fileVideoStreamer');
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
    chooseAudioFollowAction
} = require('./lib/fileSync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const player = new MpvController();
const fileVideo = new FileVideoStreamer();

function freshState() {
    return {
        tvSocket: null,
        initSegment: null,
        ffmpegProcess: null,
        mp4frag: null,
        tvSyncState: null,
        captureStartedAtMs: null,
        captureTimelineStartedAtMs: null,
        tvCaptureBaseTime: null,
        tvCaptureBaseReceivedAt: null
    };
}

let S = freshState();
let streamWatchdog = null;
let syncResumeTimer = null;
let syncResyncing = false;
let lastRateCommandAt = 0;
let lastPlaybackRate = 1;
let lastAudioFollowSpeed = 1;
let lastAudioFollowSeekAt = 0;
let manualVideoOffsetSeconds = 0;
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
const segmentStats = {
    desktop: createSegmentStats(),
    file: createSegmentStats()
};

function createSegmentStats() {
    return {
        count: 0,
        bytes: 0,
        dropped: 0,
        droppedBytes: 0,
        startedAt: Date.now(),
        lastEventAt: 0,
        lastBytes: 0
    };
}

function resetSegmentStats(kind) {
    segmentStats[kind] = createSegmentStats();
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
        captureRunning: !!S.ffmpegProcess,
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
    return !!(S.tvSocket && S.tvSocket.readyState === 1);
}

function sendTvControl(payload) {
    if (!isTvConnected()) {
        return false;
    }

    try {
        S.tvSocket.send(JSON.stringify(payload));
        return true;
    } catch (err) {
        reportError('tv_control_send_failed', err);
        return false;
    }
}

function sendTvSegment(chunk, kind = 'file') {
    if (isTvConnected()) {
        try {
            S.tvSocket.send(chunk);
        } catch (err) {
            reportError('tv_segment_send_failed', err);
        }
    }
}

function clearSyncResume() {
    if (syncResumeTimer) {
        clearTimeout(syncResumeTimer);
        syncResumeTimer = null;
    }
}

function scheduleSyncedResume(delaySeconds) {
    clearSyncResume();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    syncResumeTimer = setTimeout(async () => {
        syncResumeTimer = null;
        try {
            if (player.getStatus().loaded) {
                await player.setSpeed(1);
                lastAudioFollowSpeed = 1;
            }
            sendTvControl({ type: 'play' });
            await player.play();
        } catch (err) {
            reportError('sync_resume_failed', err);
        }
    }, delayMs);
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
    sendFixedLatencyControl({ force: true, reason: 'desktop_capture_start' });
    sendTvControl({
        type: 'reset',
        autoPlay: !fixedLatencyOptions.enabled,
        reason: 'desktop_capture_start'
    });
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
    const startTime = Math.max(
        0,
        Number(options && options.startTime) || (status.timePos + manualVideoOffsetSeconds) || 0
    );

    stopCapture();
    await player.pause();
    await player.setSpeed(1);
    lastAudioFollowSpeed = 1;
    sendFilePlaybackTvControls('file_playback_start');
    sendTvControl({ type: 'reset' });
    resetSegmentStats('file');

    fileVideo.start(status.filePath, {
        startTime,
        ...streamOptions,
        sendSegment: sendTvSegment
    });

    if (options && options.autoPlay) {
        scheduleSyncedResume(delaySeconds);
    }

    return getPlayerBundle();
}

async function seekPlayerAndTv(targetTime, shouldResume) {
    clearSyncResume();
    await player.pause();
    await player.setSpeed(1);
    lastAudioFollowSpeed = 1;
    sendFilePlaybackTvControls('file_seek');
    sendTvControl({ type: 'pause' });
    const playerStatus = await player.seek(targetTime);

    if (fileVideo.getStatus().active || fileVideo.getStatus().filePath) {
        sendTvControl({ type: 'reset' });
        resetSegmentStats('file');
        fileVideo.restartAt(Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds), streamOptions);
    }

    if (shouldResume) {
        scheduleSyncedResume(5);
    }

    return getPlayerBundle();
}

async function handleTvSyncState(tvState) {
    S.tvSyncState = {
        ...tvState,
        receivedAt: Date.now()
    };
    updateMirrorSyncFromTvSyncState(tvState);
    if (S.ffmpegProcess && fixedLatencyOptions.enabled) {
        sendFixedLatencyControl({ reason: 'sync_state' });
    }

    const streamStatus = fileVideo.getStatus();
    const playerStatus = player.getStatus();
    if (!streamStatus.active || !playerStatus.loaded || playerStatus.paused) return;
    if (!Number.isFinite(tvState.currentTime)) return;

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

    const action = chooseAudioFollowAction(fileSync);
    const now = Date.now();

    if (action.type === 'seek' && !syncResyncing && now - lastAudioFollowSeekAt >= 1000) {
        syncResyncing = true;
        lastAudioFollowSeekAt = now;
        try {
            await player.seek(action.targetTimeSeconds);
            await player.setSpeed(1);
            lastAudioFollowSpeed = 1;
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
    if (!S.ffmpegProcess || !S.captureTimelineStartedAtMs) return;
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
            pendingResume: !!syncResumeTimer,
            targetDelaySeconds: 5,
            lastPlaybackRate,
            lastAudioFollowSpeed,
            manualVideoOffsetSeconds
        },
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState()
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

    S.tvSocket = ws;

    sendFixedLatencyControl({ force: true, reason: 'tv_connected' });

    if (S.initSegment) {
        sendTvSegment(S.initSegment, 'desktop');
    }

    const fileStatus = fileVideo.getStatus();
    if (fileStatus.hasInitSegment && fileVideo.initSegment) {
        sendTvSegment(fileVideo.initSegment, 'file');
    }

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            return;
        }

        try {
            const payload = JSON.parse(message.toString('utf8'));
            if (payload.type === 'sync_state') {
                handleTvSyncState(payload).catch((err) => {
                    reportError('tv_sync_state_handling_failed', err);
                });
            }
        } catch (err) {
            reportError('tv_message_invalid', err);
        }
    });

    ws.on('close', () => {
        if (S.tvSocket === ws) S.tvSocket = null;
    });

    ws.on('error', (err) => reportError('tv_socket_error', err));
});

function stopCapture() {
    if (S.ffmpegProcess) {
        S.ffmpegProcess.kill('SIGKILL');
        S.ffmpegProcess = null;
    }

    if (S.mp4frag) {
        S.mp4frag.removeAllListeners();
        S.mp4frag = null;
    }

    S.initSegment = null;
    S.captureStartedAtMs = null;
    S.captureTimelineStartedAtMs = null;
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
}

function resetWatchdog() {
    if (streamWatchdog) clearTimeout(streamWatchdog);

    streamWatchdog = setTimeout(() => {
        if (S.ffmpegProcess) {
            startCapture();
        }
    }, 5000);
}

function startCapture() {
    stopCapture();
    resetSegmentStats('desktop');
    S.captureStartedAtMs = Date.now();
    S.captureTimelineStartedAtMs = null;
    S.tvCaptureBaseTime = null;
    S.tvCaptureBaseReceivedAt = null;
    resetTvForDesktopCapture();

    S.mp4frag = new Mp4Frag();

    S.mp4frag.on('initialized', (data) => {
        S.initSegment = data.initialization;
        S.captureTimelineStartedAtMs = Date.now();
        S.tvCaptureBaseTime = null;
        S.tvCaptureBaseReceivedAt = null;

        sendTvSegment(S.initSegment, 'desktop');

        resetWatchdog();
    });

    S.mp4frag.on('segment', (data) => {
        sendTvSegment(data.segment, 'desktop');

        resetWatchdog();
    });

    const ffmpegArgs = [
        '-probesize', '42M',
        '-analyzeduration', '0',
        '-rtbufsize', '1024M',
        '-thread_queue_size', '512',
        '-f', 'lavfi',
        '-i', 'ddagrab=framerate=60',
        '-vf', 'hwdownload,format=bgra',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-sc_threshold', '0',
        '-g', '15',
        '-keyint_min', '15',
        '-pix_fmt', 'yuv420p',
        '-b:v', '20000k',
        '-maxrate', '20000k',
        '-bufsize', '20000k',
        '-f', 'mp4',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
    ];

    S.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    S.ffmpegProcess.stdout.pipe(S.mp4frag);

    S.ffmpegProcess.stderr.on('data', (chunk) => {
        // Drain stderr so FFmpeg cannot block on a full pipe.
        chunk.length;
    });

    S.ffmpegProcess.on('error', (err) => {
        reportError('desktop_ffmpeg_error', err);
    });

    S.ffmpegProcess.on('close', () => {
        if (streamWatchdog) clearTimeout(streamWatchdog);
    });
}

app.post('/start', (req, res) => {
    startCapture();
    res.json({ success: true, message: 'Capture started' });
});

app.post('/stop', (req, res) => {
    stopCapture();
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
    const status = await player.open(media.filePath);

    res.json({
        success: true,
        media,
        player: status
    });
}));

app.post('/api/player/play', asyncRoute(async (req, res) => {
    if (fileVideo.getStatus().active) {
        sendFilePlaybackTvControls('file_player_play');
    }
    sendTvControl({ type: 'play' });
    const status = await player.play();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/pause', asyncRoute(async (req, res) => {
    clearSyncResume();
    sendTvControl({ type: 'pause' });
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
    sendTvControl({ type: 'reset' });
    fileVideo.stop();
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
    sendTvControl({ type: 'reset' });
    const tvVideo = fileVideo.stop();
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
    if (tvStatus.active && playerStatus.loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
        sendFilePlaybackTvControls('file_options_restart');
        sendTvControl({ type: 'reset' });
        resetSegmentStats('file');
        fileVideo.restartAt(Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds), streamOptions);
        if (playerStatus.paused === false) scheduleSyncedResume(5);
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
    if (tvStatus.active && playerStatus.loaded) {
        await player.setSpeed(1);
        lastAudioFollowSpeed = 1;
        sendFilePlaybackTvControls('file_nudge_restart');
        sendTvControl({ type: 'reset' });
        resetSegmentStats('file');
        fileVideo.restartAt(Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds), streamOptions);
        if (playerStatus.paused === false) scheduleSyncedResume(5);
    }

    res.json({ success: true, ...getPlayerBundle(), streamOptions });
}));

app.get('/api/player/status', asyncRoute(async (req, res) => {
    const status = await player.refreshCoreProperties();
    res.json({
        success: true,
        player: status,
        tvVideo: fileVideo.getStatus(),
        tvSyncState: S.tvSyncState,
        sync: {
            pendingResume: !!syncResumeTimer,
            targetDelaySeconds: 5,
            lastPlaybackRate,
            lastAudioFollowSpeed,
            manualVideoOffsetSeconds
        },
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState(),
        streamOptions,
        dependencies: {
            mpv: resolveMpvPath(),
            ffprobe: resolveFfprobePath(),
            ffmpeg: resolveFfmpegPath()
        }
    });
}));

app.get('/status', (req, res) => {
    res.json({
        running: !!S.ffmpegProcess,
        tvConnected: !!S.tvSocket,
        player: player.getStatus(),
        tvVideo: fileVideo.getStatus(),
        tvSyncState: S.tvSyncState,
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState()
    });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`Open http://localhost:${PORT} in Chrome to start streaming`);
});

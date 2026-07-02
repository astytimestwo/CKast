const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');
const { MpvController, resolveMpvPath } = require('./lib/mpvController');
const { probeMedia, resolveFfprobePath } = require('./lib/mediaProbe');
const { FileVideoStreamer, resolveFfmpegPath } = require('./lib/fileVideoStreamer');
const { createLiveTelemetry } = require('./lib/liveTelemetry');
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
const telemetry = createLiveTelemetry();

function freshState() {
    return {
        tvSocket: null,
        initSegment: null,
        ffmpegProcess: null,
        mp4frag: null,
        tvTelemetry: null,
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
let lastTvTelemetryLogAt = 0;
let lastDesktopFfmpegLogAt = 0;
let lastFileEncoderSegmentLogAt = 0;
let lastMirrorTelemetryLogAt = 0;
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

function recordSegmentFlow(kind, chunk, delivered) {
    const stats = segmentStats[kind];
    const bytes = chunk && chunk.length !== undefined ? chunk.length : 0;
    const now = Date.now();

    if (delivered) {
        stats.count += 1;
        stats.bytes += bytes;
    } else {
        stats.dropped += 1;
        stats.droppedBytes += bytes;
    }
    stats.lastBytes = bytes;

    if (stats.count + stats.dropped === 1 || now - stats.lastEventAt >= 2000) {
        stats.lastEventAt = now;
        telemetry.info(kind + '_segment_flow', {
            delivered,
            count: stats.count,
            bytes: stats.bytes,
            dropped: stats.dropped,
            droppedBytes: stats.droppedBytes,
            lastBytes: bytes
        });
    }
}

function getRemoteAddress(req) {
    return req && req.socket ? req.socket.remoteAddress : undefined;
}

function getMirrorSyncState(nowMs = Date.now()) {
    const captureStartedAtMs = S.captureTimelineStartedAtMs || S.captureStartedAtMs;
    const tvTelemetry = S.tvTelemetry || {};
    const lagSeconds = calculateMirrorLagSeconds({
        captureStartedAtMs,
        nowMs,
        tvBaseTimeSeconds: S.tvCaptureBaseTime,
        tvCurrentTimeSeconds: tvTelemetry.currentTime
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
        tvCurrentTimeSeconds: Number.isFinite(tvTelemetry.currentTime) ? tvTelemetry.currentTime : null,
        tvBufferedEnd: Number.isFinite(tvTelemetry.bufferedEnd) ? tvTelemetry.bufferedEnd : null,
        tvReadyState: tvTelemetry.readyState,
        lastTvTelemetryAt: tvTelemetry.receivedAt || null
    };
}

function getDebugSnapshot() {
    return {
        time: new Date().toISOString(),
        process: {
            pid: process.pid,
            uptimeSeconds: Math.round(process.uptime()),
            memory: process.memoryUsage()
        },
        tv: {
            connected: isTvConnected(),
            readyState: S.tvSocket ? S.tvSocket.readyState : null,
            telemetry: S.tvTelemetry
        },
        desktopCapture: {
            running: !!S.ffmpegProcess,
            ffmpegPid: S.ffmpegProcess ? S.ffmpegProcess.pid : null,
            hasInitSegment: !!S.initSegment,
            segmentStats: { ...segmentStats.desktop }
        },
        player: player.getStatus(),
        tvVideo: fileVideo.getStatus(),
        fileSegmentStats: { ...segmentStats.file },
        sync: {
            pendingResume: !!syncResumeTimer,
            resyncing: syncResyncing,
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
    };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
        const isPollingRoute = req.method === 'GET' && (
            req.path === '/status' ||
            req.path === '/api/player/status' ||
            req.path === '/api/debug/snapshot'
        );
        if (isPollingRoute && res.statusCode < 400) return;

        telemetry.info('http_request', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt
        });
    });
    next();
});

player.on('error', (err) => {
    telemetry.error('mpv_error', err);
});

player.on('log', (message) => {
    telemetry.info('mpv_log', { message });
});

fileVideo.on('error', (err) => {
    telemetry.error('file_video_error', err);
});

fileVideo.on('log', (message) => {
    telemetry.warn('file_video_log', { message });
});

fileVideo.on('start', (event) => {
    resetSegmentStats('file');
    telemetry.info('file_video_start', event);
});

fileVideo.on('initialized', (segment) => {
    telemetry.info('file_video_initialized', {
        bytes: segment ? segment.length : 0
    });
});

fileVideo.on('ffmpeg_spawn', (event) => {
    telemetry.info('file_video_ffmpeg_spawn', event);
});

fileVideo.on('segment', (event) => {
    const now = Date.now();
    if (now - lastFileEncoderSegmentLogAt < 2000) return;
    lastFileEncoderSegmentLogAt = now;
    telemetry.info('file_video_encoder_segment', event);
});

fileVideo.on('close', (event) => {
    telemetry.info('file_video_close', event);
});

fileVideo.on('stop', (event) => {
    telemetry.info('file_video_stop', event);
});

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((err) => {
            telemetry.error('api_error', {
                method: req.method,
                path: req.path,
                message: err.message,
                stack: err.stack
            });
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
        telemetry.warn('tv_control_dropped', {
            type: payload && payload.type,
            reason: 'tv_not_connected'
        });
        return false;
    }

    try {
        S.tvSocket.send(JSON.stringify(payload));
        telemetry.info('tv_control_sent', payload);
        return true;
    } catch (err) {
        telemetry.error('tv_control_send_failed', {
            type: payload && payload.type,
            message: err.message
        });
        return false;
    }
}

function sendTvSegment(chunk, kind = 'file') {
    if (isTvConnected()) {
        try {
            S.tvSocket.send(chunk);
            recordSegmentFlow(kind, chunk, true);
        } catch (err) {
            recordSegmentFlow(kind, chunk, false);
            telemetry.error('tv_segment_send_failed', {
                kind,
                bytes: chunk && chunk.length !== undefined ? chunk.length : 0,
                message: err.message
            });
        }
    } else {
        recordSegmentFlow(kind, chunk, false);
    }
}

function clearSyncResume() {
    if (syncResumeTimer) {
        clearTimeout(syncResumeTimer);
        syncResumeTimer = null;
        telemetry.info('sync_resume_cleared');
    }
}

function scheduleSyncedResume(delaySeconds) {
    clearSyncResume();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    telemetry.info('sync_resume_scheduled', { delayMs });
    syncResumeTimer = setTimeout(async () => {
        syncResumeTimer = null;
        try {
            telemetry.info('sync_resume_firing');
            if (player.getStatus().loaded) {
                await player.setSpeed(1);
                lastAudioFollowSpeed = 1;
            }
            sendTvControl({ type: 'play' });
            await player.play();
        } catch (err) {
            telemetry.error('sync_resume_failed', err);
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
    telemetry.info('stream_options_applied', streamOptions);
    sendTvControl({ type: 'fit', mode: streamOptions.fitMode });
    return streamOptions;
}

function applyFixedLatencyOptions(input) {
    fixedLatencyOptions = normalizeFixedLatencyOptions({
        ...fixedLatencyOptions,
        ...(input || {})
    });
    telemetry.info('fixed_latency_options_applied', fixedLatencyOptions);
    sendFixedLatencyControl({ force: true, reason: 'api_update' });
    return getFixedLatencyState();
}

function getTvBufferAheadSeconds() {
    const tvTelemetry = S.tvTelemetry || {};
    const tvFixedLatency = tvTelemetry.fixedLatency || {};
    const fixedBufferAhead = Number(tvFixedLatency.bufferAheadSeconds);
    if (Number.isFinite(fixedBufferAhead)) return Math.max(0, fixedBufferAhead);

    const bufferedEnd = Number(tvTelemetry.bufferedEnd);
    const currentTime = Number(tvTelemetry.currentTime);
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
        tv: S.tvTelemetry && S.tvTelemetry.fixedLatency ? S.tvTelemetry.fixedLatency : null
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
        telemetry.info('fixed_latency_control_updated', control);
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
    telemetry.info('tv_video_start_requested', {
        autoPlay: !!(options && options.autoPlay),
        delaySeconds: options && options.delaySeconds,
        requestedStartTime: options && options.startTime
    });

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
    telemetry.info('seek_player_and_tv_requested', { targetTime, shouldResume });
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

async function handleTvTelemetry(tvState) {
    S.tvTelemetry = {
        ...tvState,
        receivedAt: Date.now()
    };
    updateMirrorSyncFromTvTelemetry(tvState);
    if (S.ffmpegProcess && fixedLatencyOptions.enabled) {
        sendFixedLatencyControl({ reason: 'telemetry' });
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
    S.tvTelemetry.drift = drift;
    S.tvTelemetry.fileSync = fileSync;

    const nowForTelemetry = Date.now();
    if (nowForTelemetry - lastTvTelemetryLogAt >= 2000) {
        lastTvTelemetryLogAt = nowForTelemetry;
        telemetry.info('tv_telemetry_sample', {
            currentTime: tvState.currentTime,
            bufferedEnd: tvState.bufferedEnd,
            paused: tvState.paused,
            playbackRate: tvState.playbackRate,
            queueLength: tvState.queueLength,
            readyState: tvState.readyState,
            fixedLatency: tvState.fixedLatency,
            fileSync
        });
    }

    if (!fileSync.canSync) return;

    const action = chooseAudioFollowAction(fileSync);
    const now = Date.now();

    if (action.type === 'seek' && !syncResyncing && now - lastAudioFollowSeekAt >= 1000) {
        syncResyncing = true;
        lastAudioFollowSeekAt = now;
        telemetry.warn('file_audio_follow_seek_started', {
            driftSeconds: fileSync.driftSeconds,
            targetTimeSeconds: action.targetTimeSeconds,
            reason: action.reason
        });
        try {
            await player.seek(action.targetTimeSeconds);
            await player.setSpeed(1);
            lastAudioFollowSpeed = 1;
        } catch (err) {
            telemetry.error('file_audio_follow_seek_failed', err);
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
        telemetry.info('file_audio_follow_speed_adjusted', {
            driftSeconds: fileSync.driftSeconds,
            speed: action.speed,
            reason: action.reason
        });
        await player.setSpeed(action.speed);
    }
}

function updateMirrorSyncFromTvTelemetry(tvState) {
    if (!S.ffmpegProcess || !S.captureTimelineStartedAtMs) return;
    if (!Number.isFinite(tvState.currentTime)) return;

    if (!Number.isFinite(S.tvCaptureBaseTime)) {
        S.tvCaptureBaseTime = tvState.currentTime;
        S.tvCaptureBaseReceivedAt = Date.now();
        telemetry.info('mirror_sync_tv_base_set', {
            tvBaseTimeSeconds: S.tvCaptureBaseTime
        });
    }

    const state = getMirrorSyncState();
    if (!state.canEstimate) return;

    S.tvTelemetry.mirrorLag = state.lagSeconds;
    const now = Date.now();
    if (now - lastMirrorTelemetryLogAt >= 2000) {
        lastMirrorTelemetryLogAt = now;
        telemetry.info('mirror_sync_sample', {
            lagSeconds: state.lagSeconds,
            recommendedAudioDelaySeconds: state.recommendedAudioDelaySeconds,
            currentAudioDelaySeconds: state.currentAudioDelaySeconds,
            tvCurrentTimeSeconds: state.tvCurrentTimeSeconds,
            tvBufferedEnd: state.tvBufferedEnd,
            tvReadyState: state.tvReadyState
        });
    }
}

function getPlayerBundle() {
    return {
        player: player.getStatus(),
        tvVideo: fileVideo.getStatus(),
        tvTelemetry: S.tvTelemetry,
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

app.get('/api/debug/events', (req, res) => {
    telemetry.attachSse(req, res);
    telemetry.info('debug_events_client_connected', {
        remoteAddress: getRemoteAddress(req)
    });
    req.on('close', () => {
        telemetry.info('debug_events_client_disconnected', {
            remoteAddress: getRemoteAddress(req)
        });
    });
});

app.get('/api/debug/snapshot', (req, res) => {
    res.json({
        success: true,
        snapshot: getDebugSnapshot()
    });
});

wss.on('connection', (ws, req) => {
    if (req.url !== '/tv') {
        telemetry.warn('ws_connection_rejected', {
            url: req.url,
            remoteAddress: getRemoteAddress(req)
        });
        ws.close(1008, 'Unsupported websocket path');
        return;
    }

    telemetry.info('tv_connected', {
        remoteAddress: getRemoteAddress(req),
        userAgent: req.headers['user-agent']
    });
    S.tvSocket = ws;

    sendFixedLatencyControl({ force: true, reason: 'tv_connected' });

    if (S.initSegment) {
        telemetry.info('desktop_init_replayed', { bytes: S.initSegment.length });
        sendTvSegment(S.initSegment, 'desktop');
    }

    const fileStatus = fileVideo.getStatus();
    if (fileStatus.hasInitSegment && fileVideo.initSegment) {
        telemetry.info('file_video_init_replayed', { bytes: fileVideo.initSegment.length });
        sendTvSegment(fileVideo.initSegment, 'file');
    }

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            telemetry.warn('tv_binary_message_ignored', { bytes: message.length });
            return;
        }

        try {
            const payload = JSON.parse(message.toString('utf8'));
            if (payload.type === 'telemetry') {
                handleTvTelemetry(payload).catch((err) => {
                    telemetry.error('tv_telemetry_handling_failed', err);
                });
            } else if (payload.type === 'client_event') {
                telemetry.info('tv_client_event', {
                    event: payload.event,
                    data: payload.data
                });
            } else {
                telemetry.warn('tv_message_unknown', { type: payload.type });
            }
        } catch (err) {
            telemetry.error('tv_message_invalid', {
                message: err.message,
                raw: message.toString('utf8').slice(0, 500)
            });
        }
    });

    ws.on('close', (code, reason) => {
        telemetry.warn('tv_disconnected', {
            code,
            reason: reason ? reason.toString() : ''
        });
        if (S.tvSocket === ws) S.tvSocket = null;
    });

    ws.on('error', (err) => telemetry.error('tv_socket_error', err));
});

function stopCapture() {
    if (S.ffmpegProcess) {
        telemetry.info('desktop_capture_stop_requested', { pid: S.ffmpegProcess.pid });
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
            telemetry.warn('desktop_capture_watchdog_restart', {
                pid: S.ffmpegProcess.pid,
                reason: 'no_segments_for_5s'
            });
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
    telemetry.info('desktop_capture_start_requested');
    resetTvForDesktopCapture();

    S.mp4frag = new Mp4Frag();

    S.mp4frag.on('initialized', (data) => {
        S.initSegment = data.initialization;
        S.captureTimelineStartedAtMs = Date.now();
        S.tvCaptureBaseTime = null;
        S.tvCaptureBaseReceivedAt = null;
        telemetry.info('desktop_capture_initialized', {
            bytes: S.initSegment ? S.initSegment.length : 0
        });

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

    telemetry.info('desktop_ffmpeg_spawn', {
        command: 'ffmpeg',
        args: ffmpegArgs
    });

    S.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    S.ffmpegProcess.stdout.pipe(S.mp4frag);

    S.ffmpegProcess.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        const now = Date.now();
        if (message && now - lastDesktopFfmpegLogAt >= 1000) {
            lastDesktopFfmpegLogAt = now;
            telemetry.warn('desktop_ffmpeg_stderr', { message });
        }
    });

    S.ffmpegProcess.on('error', (err) => {
        telemetry.error('desktop_ffmpeg_error', err);
    });

    S.ffmpegProcess.on('close', (code) => {
        telemetry.warn('desktop_ffmpeg_close', { code });
        if (streamWatchdog) clearTimeout(streamWatchdog);
    });
}

app.post('/start', (req, res) => {
    telemetry.info('desktop_capture_api_start');
    startCapture();
    res.json({ success: true, message: 'Capture started' });
});

app.post('/stop', (req, res) => {
    telemetry.info('desktop_capture_api_stop');
    stopCapture();
    res.json({ success: true, message: 'Capture stopped' });
});

app.post('/api/fixed-latency', asyncRoute(async (req, res) => {
    const fixedLatency = applyFixedLatencyOptions(req.body || {});
    res.json({
        success: true,
        fixedLatency,
        mirrorSync: getMirrorSyncState(),
        tvTelemetry: S.tvTelemetry
    });
}));

app.post('/api/player/open', asyncRoute(async (req, res) => {
    const filePath = req.body && req.body.filePath;
    telemetry.info('player_open_requested', { filePath });
    const media = await probeMedia(filePath);
    const status = await player.open(media.filePath);
    telemetry.info('player_opened', {
        filePath: media.filePath,
        duration: media.duration,
        videoStreams: media.videoStreams ? media.videoStreams.length : undefined,
        subtitleStreams: media.subtitleStreams ? media.subtitleStreams.length : undefined
    });

    res.json({
        success: true,
        media,
        player: status
    });
}));

app.post('/api/player/play', asyncRoute(async (req, res) => {
    telemetry.info('player_play_requested');
    if (fileVideo.getStatus().active) {
        sendFilePlaybackTvControls('file_player_play');
    }
    sendTvControl({ type: 'play' });
    const status = await player.play();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/pause', asyncRoute(async (req, res) => {
    telemetry.info('player_pause_requested');
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
    telemetry.info('player_seek_requested', { time: req.body && req.body.time });
    const wasPlaying = player.getStatus().paused === false;
    const bundle = await seekPlayerAndTv(req.body && req.body.time, wasPlaying);
    res.json({ success: true, ...bundle });
}));

app.post('/api/player/volume', asyncRoute(async (req, res) => {
    telemetry.info('player_volume_requested', { volume: req.body && req.body.volume });
    const status = await player.setVolume(req.body && req.body.volume);
    res.json({ success: true, player: status });
}));

app.post('/api/player/audio-delay', asyncRoute(async (req, res) => {
    const delaySeconds = Number(req.body && req.body.delaySeconds);
    telemetry.info('player_audio_delay_requested', { delaySeconds });
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
    telemetry.info('player_audio_delay_nudge_requested', {
        deltaSeconds,
        currentDelay,
        nextDelay
    });
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
        throw new Error('Start desktop capture and wait for TV telemetry before syncing audio.');
    }

    telemetry.info('mirror_audio_sync_requested', mirrorSync);
    const status = await player.setAudioDelay(mirrorSync.recommendedAudioDelaySeconds);
    res.json({
        success: true,
        player: status,
        mirrorSync: getMirrorSyncState()
    });
}));

app.post('/api/player/stop', asyncRoute(async (req, res) => {
    telemetry.info('player_stop_requested');
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
    telemetry.info('tv_video_stop_requested');
    clearSyncResume();
    sendTvControl({ type: 'reset' });
    const tvVideo = fileVideo.stop();
    res.json({ success: true, tvVideo, player: player.getStatus() });
}));

app.post('/api/player/tv/resync', asyncRoute(async (req, res) => {
    telemetry.info('tv_video_resync_requested');
    const status = await player.refreshCoreProperties();
    const bundle = await seekPlayerAndTv(status.timePos, status.paused === false);
    res.json({ success: true, ...bundle });
}));

app.post('/api/player/tv/options', asyncRoute(async (req, res) => {
    telemetry.info('tv_video_options_requested', req.body || {});
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
    telemetry.info('tv_video_fit_requested', { fitMode: req.body && req.body.fitMode });
    applyStreamOptions({ fitMode: req.body && req.body.fitMode });
    res.json({ success: true, streamOptions, ...getPlayerBundle() });
}));

app.post('/api/player/tv/nudge', asyncRoute(async (req, res) => {
    const delta = Number(req.body && req.body.deltaSeconds) || 0;
    manualVideoOffsetSeconds = Math.max(-10, Math.min(10, manualVideoOffsetSeconds + delta));
    telemetry.info('tv_video_nudge_requested', {
        deltaSeconds: delta,
        manualVideoOffsetSeconds
    });

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
        tvTelemetry: S.tvTelemetry,
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
        tvTelemetry: S.tvTelemetry,
        mirrorSync: getMirrorSyncState(),
        fixedLatency: getFixedLatencyState()
    });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    telemetry.info('server_started', {
        port: PORT,
        dashboardUrl: `http://localhost:${PORT}`,
        liveTelemetryUrl: `http://localhost:${PORT}/api/debug/events`,
        snapshotUrl: `http://localhost:${PORT}/api/debug/snapshot`,
        dependencies: {
            mpv: resolveMpvPath(),
            ffprobe: resolveFfprobePath(),
            ffmpeg: resolveFfmpegPath()
        }
    });
    console.log(`\nCKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`Open http://localhost:${PORT} in Chrome to start streaming`);
    console.log(`Live telemetry: http://localhost:${PORT}/api/debug/events`);
    console.log(`Current snapshot: http://localhost:${PORT}/api/debug/snapshot`);
});

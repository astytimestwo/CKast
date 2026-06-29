const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');
const { MpvController, resolveMpvPath } = require('./lib/mpvController');
const { probeMedia, resolveFfprobePath } = require('./lib/mediaProbe');
const { FileVideoStreamer, resolveFfmpegPath } = require('./lib/fileVideoStreamer');

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
        tvTelemetry: null
    };
}

let S = freshState();
let streamWatchdog = null;
let syncResumeTimer = null;
let syncResyncing = false;
let lastRateCommandAt = 0;
let lastPlaybackRate = 1;
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

player.on('error', (err) => {
    console.error('[MPV] Error:', err.message);
});

player.on('log', (message) => {
    console.log('[MPV]', message);
});

fileVideo.on('error', (err) => {
    console.error('[FileVideo] Error:', err.message);
});

fileVideo.on('log', (message) => {
    console.log('[FileVideo]', message);
});

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((err) => {
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
    if (!isTvConnected()) return false;
    S.tvSocket.send(JSON.stringify(payload));
    return true;
}

function sendTvSegment(chunk) {
    if (isTvConnected()) {
        S.tvSocket.send(chunk);
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
            sendTvControl({ type: 'play' });
            await player.play();
        } catch (err) {
            console.error('[Sync] Could not resume:', err.message);
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
    sendTvControl({ type: 'reset' });

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
    sendTvControl({ type: 'pause' });
    const playerStatus = await player.seek(targetTime);

    if (fileVideo.getStatus().active || fileVideo.getStatus().filePath) {
        sendTvControl({ type: 'reset' });
        fileVideo.restartAt(Math.max(0, playerStatus.timePos + manualVideoOffsetSeconds), streamOptions);
    }

    if (shouldResume) {
        scheduleSyncedResume(5);
    }

    return getPlayerBundle();
}

async function handleTvTelemetry(telemetry) {
    S.tvTelemetry = {
        ...telemetry,
        receivedAt: Date.now()
    };

    const streamStatus = fileVideo.getStatus();
    const playerStatus = player.getStatus();
    if (!streamStatus.active || !playerStatus.loaded || playerStatus.paused) return;
    if (!Number.isFinite(telemetry.currentTime)) return;

    const tvAbsoluteTime = streamStatus.streamStartTime + telemetry.currentTime;
    const drift = tvAbsoluteTime - (playerStatus.timePos + manualVideoOffsetSeconds);
    S.tvTelemetry.drift = drift;

    if (Math.abs(drift) > 2.5 && !syncResyncing) {
        syncResyncing = true;
        try {
            await player.pause();
            sendTvControl({ type: 'pause' });
            sendTvControl({ type: 'reset' });
            const refreshed = await player.refreshCoreProperties();
            fileVideo.restartAt(Math.max(0, refreshed.timePos + manualVideoOffsetSeconds), streamOptions);
            scheduleSyncedResume(5);
        } catch (err) {
            console.error('[Sync] Resync failed:', err.message);
        } finally {
            setTimeout(() => { syncResyncing = false; }, 2000);
        }
        return;
    }

    const now = Date.now();
    if (now - lastRateCommandAt < 750) return;

    let nextRate = 1;
    if (drift > 0.15) {
        nextRate = 0.98;
    } else if (drift < -0.15) {
        nextRate = 1.02;
    }

    if (nextRate !== lastPlaybackRate) {
        lastPlaybackRate = nextRate;
        lastRateCommandAt = now;
        sendTvControl({ type: 'setPlaybackRate', rate: nextRate });
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
            manualVideoOffsetSeconds
        }
    };
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

wss.on('connection', (ws, req) => {
    if (req.url !== '/tv') return;

    console.log('[TV] Connected');
    S.tvSocket = ws;

    if (S.initSegment) {
        console.log(`[TV] Sending cached init segment (${S.initSegment.length} bytes)`);
        ws.send(S.initSegment);
    }

    const fileStatus = fileVideo.getStatus();
    if (fileStatus.hasInitSegment && fileVideo.initSegment) {
        console.log(`[TV] Sending cached file-video init segment (${fileVideo.initSegment.length} bytes)`);
        ws.send(fileVideo.initSegment);
    }

    ws.on('message', (message, isBinary) => {
        if (isBinary) return;

        try {
            const payload = JSON.parse(message.toString('utf8'));
            if (payload.type === 'telemetry') {
                handleTvTelemetry(payload).catch((err) => {
                    console.error('[TV] Telemetry handling failed:', err.message);
                });
            }
        } catch (err) {
            console.error('[TV] Invalid message:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('[TV] Disconnected');
        S.tvSocket = null;
    });

    ws.on('error', (err) => console.error('[TV] Error:', err.message));
});

function stopCapture() {
    if (S.ffmpegProcess) {
        console.log('[FFMPEG] Stopping capture...');
        S.ffmpegProcess.kill('SIGKILL');
        S.ffmpegProcess = null;
    }

    if (S.mp4frag) {
        S.mp4frag.removeAllListeners();
        S.mp4frag = null;
    }

    S.initSegment = null;
}

function resetWatchdog() {
    if (streamWatchdog) clearTimeout(streamWatchdog);

    streamWatchdog = setTimeout(() => {
        if (S.ffmpegProcess) {
            console.log('\n[WARN] Capture frozen. Screen may be asleep or UAC may be blocking capture. Auto-restarting...');
            startCapture();
        }
    }, 5000);
}

function startCapture() {
    stopCapture();
    console.log('[FFMPEG] Starting new capture...');

    S.mp4frag = new Mp4Frag();

    S.mp4frag.on('initialized', (data) => {
        S.initSegment = data.initialization;
        console.log('[MP4Frag] Initialized - fMP4 header cached');

        if (S.tvSocket && S.tvSocket.readyState === 1) {
            S.tvSocket.send(S.initSegment);
        }

        resetWatchdog();
    });

    S.mp4frag.on('segment', (data) => {
        if (S.tvSocket && S.tvSocket.readyState === 1) {
            S.tvSocket.send(data.segment);
        }

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

    S.ffmpegProcess.stderr.on('data', () => {
        // Keep FFmpeg quiet by default. Log stderr here when debugging capture failures.
    });

    S.ffmpegProcess.on('close', (code) => {
        console.log(`[FFMPEG] Process exited with code ${code}`);
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
    sendTvControl({ type: 'play' });
    const status = await player.play();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/pause', asyncRoute(async (req, res) => {
    clearSyncResume();
    sendTvControl({ type: 'pause' });
    const status = await player.pause();
    res.json({ success: true, player: status, tvVideo: fileVideo.getStatus() });
}));

app.post('/api/player/seek', asyncRoute(async (req, res) => {
    const wasPlaying = player.getStatus().paused === false;
    const bundle = await seekPlayerAndTv(req.body && req.body.time, wasPlaying);
    res.json({ success: true, ...bundle });
}));

app.post('/api/player/volume', asyncRoute(async (req, res) => {
    const status = await player.setVolume(req.body && req.body.volume);
    res.json({ success: true, player: status });
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
        sendTvControl({ type: 'reset' });
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
        sendTvControl({ type: 'reset' });
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
            manualVideoOffsetSeconds
        },
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
        tvTelemetry: S.tvTelemetry
    });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`Open http://localhost:${PORT} in Chrome to start streaming`);
});

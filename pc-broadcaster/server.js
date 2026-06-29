const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function freshState() {
    return {
        tvSocket: null,
        initSegment: null,
        ffmpegProcess: null,
        mp4frag: null
    };
}

let S = freshState();
let streamWatchdog = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

app.get('/status', (req, res) => {
    res.json({ running: !!S.ffmpegProcess, tvConnected: !!S.tvSocket });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`Open http://localhost:${PORT} in Chrome to start streaming`);
});

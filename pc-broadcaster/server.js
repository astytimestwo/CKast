const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Session State ──
function freshState() {
    return {
        tvSocket: null,
        initSegment: null,
        ffmpegProcess: null,
        mp4frag: null
    };
}

let S = freshState();

// Serve the broadcaster dashboard
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API config for starting/stopping stream
app.use(express.json());

// TV Websocket Connection
wss.on('connection', (ws, req) => {
    const endpoint = req.url;
    if (endpoint === '/tv') {
        console.log('✅ TV Connected!');
        S.tvSocket = ws;

        // If FFmpeg is already running and we have the init segment, send it
        if (S.initSegment) {
            console.log(`[TV] Sending cached init segment (${S.initSegment.length} bytes)`);
            ws.send(S.initSegment);
        }

        ws.on('close', () => {
            console.log('[TV] Disconnected');
            S.tvSocket = null;
        });

        ws.on('error', (err) => console.error('[TV] Error:', err.message));
    }
});

function stopCapture() {
    if (S.ffmpegProcess) {
        console.log('🛑 Stopping FFmpeg...');
        S.ffmpegProcess.kill('SIGKILL');
        S.ffmpegProcess = null;
    }
    if (S.mp4frag) {
        S.mp4frag.removeAllListeners();
        S.mp4frag = null;
    }
    S.initSegment = null;
}

let streamWatchdog = null;

function resetWatchdog() {
    if (streamWatchdog) clearTimeout(streamWatchdog);
    streamWatchdog = setTimeout(() => {
        if (S.ffmpegProcess) {
            console.log('\n⚠️ Capture frozen (Screen asleep or UAC blocked). Auto-restarting...');
            startCapture();
        }
    }, 5000); // 5 seconds without frames triggers a restart
}

function startCapture() {
    stopCapture(); // Stop existing
    console.log('🚀 Starting new FFmpeg capture...');

    S.mp4frag = new Mp4Frag();

    S.mp4frag.on('initialized', (data) => {
        S.initSegment = data.initialization;
        console.log(`[MP4Frag] Initialized - fMP4 header cached`);
        if (S.tvSocket && S.tvSocket.readyState === 1) {
            S.tvSocket.send(S.initSegment);
        }
        resetWatchdog();
    });

    S.mp4frag.on('segment', (data) => {
        if (S.tvSocket && S.tvSocket.readyState === 1) {
            S.tvSocket.send(data.segment);
        }
        resetWatchdog(); // Reset timer on every successful frame
    });

    const ffmpegArgs = [
        '-probesize', '42M',     // Prevent initial startup lag
        '-analyzeduration', '0',
        '-rtbufsize', '1024M',   // Heavy buffer to prevent frame drops
        '-thread_queue_size', '512',
        '-f', 'lavfi',           // Filtergraph input
        '-i', 'ddagrab=framerate=60', // Direct Windows GPU Desktop capture (flawless 60fps, no frame drops)
        '-vf', 'hwdownload,format=bgra', // Map GPU textures back to system RAM for x264
        '-c:v', 'libx264',       // H.264 Encoder (Hardware decoded on TV)
        '-preset', 'ultrafast',  // The ONLY preset fast enough to attempt 60fps lock on CPU
        '-tune', 'zerolatency',  // No encoder buffering
        '-sc_threshold', '0',    // Disable scene change keyframes
        '-g', '15',              // Emit fragments 4x a second (250ms micro-chunks)
        '-keyint_min', '15',
        '-pix_fmt', 'yuv420p',   // Ensure compatibility
        '-b:v', '20000k',        // Bumped to 20Mbps to keep particles sharp while using ultrafast
        '-maxrate', '20000k',
        '-bufsize', '20000k',
        '-f', 'mp4',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'                 // Output directly to stdout
    ];

    S.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    S.ffmpegProcess.stdout.pipe(S.mp4frag);

    S.ffmpegProcess.stderr.on('data', (data) => {
        // Uncomment to debug FFmpeg outputs
        // console.log(`[FFMPEG] ${data.toString()}`);
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

const PORT = 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 CKast Server running on http://0.0.0.0:${PORT}`);
    console.log(`   Open http://localhost:${PORT} in Chrome to start streaming`);
});

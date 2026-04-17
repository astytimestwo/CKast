// ═══════════════════════════════════════════════════════════════
//  GIGA — Tizen TV Screen Receiver (main.js)
//  Requires H.264 fMP4 stream
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ┌─────────────────────────────────────────────────────────┐
    // │  CHANGE THIS to your PC's current local IP address      │
    // └─────────────────────────────────────────────────────────┘
    var SERVER_IP = '192.168.1.XXX';
    var SERVER_PORT = 8080;

    // ── DOM refs ──
    var video = document.getElementById('screenVideo');
    var overlay = document.getElementById('connectOverlay');
    var connectStat = document.getElementById('connectStatus');

    // ── State ──
    var ws = null;
    var mediaSource = null;
    var sourceBuffer = null;
    var queue = [];
    var hasPlayed = false;
    var reconnectTimer = null;
    var evictTimer = null;

    function setConnectStatus(msg) {
        var el = document.getElementById('connectStatusText');
        if (el) el.textContent = msg;
    }

    // ═══════════════════════════════════════════════════════════
    //  AUTO-CONNECT
    // ═══════════════════════════════════════════════════════════

    startConnection(SERVER_IP);

    function startConnection(ip) {
        cleanup();
        setConnectStatus('● Connecting to ' + ip + '...');

        mediaSource = new MediaSource();
        video.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', function () {
            try {
                // H.264 Constrained Baseline — widest Tizen compatibility
                sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
                // Sequence mode ignores internal timestamps — prevents gap-related stutters
                sourceBuffer.mode = 'sequence';
            } catch (e) {
                setConnectStatus('ERROR: ' + e.message);
                return;
            }

            sourceBuffer.addEventListener('updateend', processQueue);
            sourceBuffer.addEventListener('error', function () {
                console.error('[SB] error event');
            });

            connectWebSocket(ip);
        });
    }

    function connectWebSocket(ip) {
        var url = 'ws://' + ip + ':' + SERVER_PORT + '/tv';

        try {
            ws = new WebSocket(url);
        } catch (e) {
            scheduleReconnect(ip);
            return;
        }

        ws.binaryType = 'arraybuffer';

        ws.onopen = function () {
            setConnectStatus('Connected — waiting for stream...');
            if (evictTimer) clearInterval(evictTimer);
            evictTimer = setInterval(evictBuffer, 20000);
        };

        ws.onmessage = function (event) {
            queue.push(event.data);
            processQueue();

            if (!overlay.classList.contains('hidden')) {
                overlay.classList.add('hidden');
            }
        };

        ws.onclose = function () {
            overlay.classList.remove('hidden');
            setConnectStatus('● Reconnecting...');
            scheduleReconnect(ip);
        };

        ws.onerror = function () {
            setConnectStatus('● Connection failed — retrying...');
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  Chunk Processing
    // ═══════════════════════════════════════════════════════════

    function processQueue() {
        if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) {
            return;
        }

        var chunk = queue.shift();

        try {
            sourceBuffer.appendBuffer(chunk);
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                evictBuffer();
                queue.unshift(chunk);
            } else {
                console.error('[MSE] err:', e.name, e.message);
            }
        }

        if (!hasPlayed) {
            hasPlayed = true;
            video.play().catch(function () {
                video.muted = true;
                video.play().catch(function () { });
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  Buffer Eviction
    // ═══════════════════════════════════════════════════════════

    function evictBuffer() {
        if (!sourceBuffer || sourceBuffer.updating) return;
        if (!video || !video.currentTime) return;

        var removeEnd = video.currentTime - 60;
        if (removeEnd <= 0) return;

        try {
            if (sourceBuffer.buffered.length > 0) {
                var buffStart = sourceBuffer.buffered.start(0);
                if (buffStart < removeEnd) {
                    sourceBuffer.remove(buffStart, removeEnd);
                }
            }
        } catch (e) { }
    }

    // ═══════════════════════════════════════════════════════════
    //  Cleanup & Reconnect
    // ═══════════════════════════════════════════════════════════

    function scheduleReconnect(ip) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () {
            startConnection(ip);
        }, 3000);
    }

    function cleanup() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
        if (ws) { try { ws.close(); } catch (e) { } ws = null; }
        queue = [];
        sourceBuffer = null;
        mediaSource = null;
        hasPlayed = false;
    }

})();
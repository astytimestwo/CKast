// CKast Tizen TV Screen Receiver
// Receives H.264 fragmented MP4 chunks plus lightweight JSON control messages.

(function () {
    'use strict';

    // Change this to your PC's current local IP address.
    var SERVER_IP = '192.168.1.XXX';
    var SERVER_PORT = 8080;

    var video = document.getElementById('screenVideo');
    var overlay = document.getElementById('connectOverlay');

    var ws = null;
    var mediaSource = null;
    var sourceBuffer = null;
    var objectUrl = null;
    var queue = [];
    var hasPlayed = false;
    var shouldAutoPlay = true;
    var reconnectTimer = null;
    var evictTimer = null;
    var telemetryTimer = null;

    function setConnectStatus(msg) {
        var el = document.getElementById('connectStatusText');
        if (el) el.textContent = msg;
    }

    startConnection(SERVER_IP);

    function startConnection(ip) {
        cleanup();
        setConnectStatus('Connecting to ' + ip + '...');
        createMediaPipeline(true);
        connectWebSocket(ip);
    }

    function createMediaPipeline(autoPlay) {
        shouldAutoPlay = autoPlay;
        hasPlayed = false;
        queue = [];
        sourceBuffer = null;

        if (objectUrl) {
            try { URL.revokeObjectURL(objectUrl); } catch (e) { }
            objectUrl = null;
        }

        mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        video.removeAttribute('src');
        video.src = objectUrl;
        video.load();

        mediaSource.addEventListener('sourceopen', function () {
            try {
                sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
                sourceBuffer.mode = 'sequence';
            } catch (e) {
                setConnectStatus('ERROR: ' + e.message);
                return;
            }

            sourceBuffer.addEventListener('updateend', processQueue);
            sourceBuffer.addEventListener('error', function () {
                console.error('[SourceBuffer] error event');
            });

            processQueue();
        });
    }

    function resetForSyncedVideo() {
        try { video.pause(); } catch (e) { }
        video.playbackRate = 1;
        overlay.classList.remove('hidden');
        setConnectStatus('Buffering synced video...');
        createMediaPipeline(false);
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
            setConnectStatus('Connected - waiting for stream...');
            if (evictTimer) clearInterval(evictTimer);
            if (telemetryTimer) clearInterval(telemetryTimer);
            evictTimer = setInterval(evictBuffer, 20000);
            telemetryTimer = setInterval(sendTelemetry, 500);
        };

        ws.onmessage = function (event) {
            if (typeof event.data === 'string') {
                handleControlMessage(event.data);
                return;
            }

            queue.push(event.data);
            processQueue();

            if (shouldAutoPlay && !overlay.classList.contains('hidden')) {
                overlay.classList.add('hidden');
            }
        };

        ws.onclose = function () {
            overlay.classList.remove('hidden');
            setConnectStatus('Reconnecting...');
            scheduleReconnect(ip);
        };

        ws.onerror = function () {
            setConnectStatus('Connection failed - retrying...');
        };
    }

    function handleControlMessage(raw) {
        var msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            console.error('[Control] invalid JSON:', raw);
            return;
        }

        if (msg.type === 'reset') {
            resetForSyncedVideo();
        } else if (msg.type === 'play') {
            shouldAutoPlay = true;
            overlay.classList.add('hidden');
            playVideo();
        } else if (msg.type === 'pause') {
            video.pause();
        } else if (msg.type === 'setPlaybackRate') {
            var rate = Number(msg.rate);
            if (rate >= 0.5 && rate <= 2) {
                video.playbackRate = rate;
            }
        } else if (msg.type === 'fit') {
            if (msg.mode === 'contain' || msg.mode === 'cover' || msg.mode === 'fill') {
                video.style.objectFit = msg.mode === 'fill' ? 'fill' : msg.mode;
            }
        }
    }

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
                console.error('[MSE] error:', e.name, e.message);
            }
        }

        if (!hasPlayed && shouldAutoPlay) {
            hasPlayed = true;
            playVideo();
        }
    }

    function playVideo() {
        video.play().catch(function () {
            video.muted = true;
            video.play().catch(function () { });
        });
    }

    function sendTelemetry() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        var bufferedEnd = 0;
        try {
            if (video.buffered.length > 0) {
                bufferedEnd = video.buffered.end(video.buffered.length - 1);
            }
        } catch (e) { }

        ws.send(JSON.stringify({
            type: 'telemetry',
            currentTime: video.currentTime || 0,
            bufferedEnd: bufferedEnd,
            paused: video.paused,
            playbackRate: video.playbackRate || 1,
            queueLength: queue.length,
            readyState: video.readyState
        }));
    }

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

    function scheduleReconnect(ip) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () {
            startConnection(ip);
        }, 3000);
    }

    function cleanup() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (evictTimer) { clearInterval(evictTimer); evictTimer = null; }
        if (telemetryTimer) { clearInterval(telemetryTimer); telemetryTimer = null; }
        if (ws) { try { ws.close(); } catch (e) { } ws = null; }
        queue = [];
        sourceBuffer = null;
        mediaSource = null;
        hasPlayed = false;
    }
})();

// CKast Tizen TV Screen Receiver
// Receives H.264 fragmented MP4 chunks plus lightweight JSON control messages.

(function () {
    'use strict';

    // Change this to your PC's current local IP address.
    var SERVER_IP = '10.204.247.239';
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
    var playbackMode = 'idle';
    var reconnectTimer = null;
    var evictTimer = null;
    var syncStateTimer = null;
    var fixedLatencyTimer = null;
    var fixedLatency = {
        enabled: true,
        targetSeconds: 2.5,
        minBufferSeconds: 2.25,
        started: false,
        lastAction: 'idle',
        lastActionAt: 0,
        lastSeekAt: 0
    };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function roundSeconds(value) {
        return Math.round(value * 1000) / 1000;
    }

    function normalizeFixedLatencyOptions(options) {
        options = options || {};
        var targetSeconds = clamp(Number(options.targetSeconds) || 2.5, 0.5, 8);
        var minBufferSeconds = clamp(
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

    function resetFixedLatencySession(reason) {
        fixedLatency.started = false;
        fixedLatency.lastAction = reason || 'reset';
        fixedLatency.lastActionAt = Date.now();
        fixedLatency.lastSeekAt = 0;
    }

    function setConnectStatus(msg) {
        var el = document.getElementById('connectStatusText');
        if (el) el.textContent = msg;
    }

    startConnection(SERVER_IP);

    function startConnection(ip) {
        cleanup();
        setConnectStatus('Connecting to ' + ip + '...');
        createMediaPipeline(true, 'Connecting to ' + ip + '...', 'idle');
        connectWebSocket(ip);
    }

    function createMediaPipeline(autoPlay, message, mode) {
        clearMediaPipeline(message || 'Preparing stream...');
        playbackMode = mode || 'file';
        shouldAutoPlay = !!autoPlay && !fixedLatency.enabled;
        hasPlayed = false;
        resetFixedLatencySession('pipeline_reset');

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

            sourceBuffer.addEventListener('updateend', function () {
                processQueue();
                runFixedLatencyController();
            });
            sourceBuffer.addEventListener('error', function () {
                console.error('[SourceBuffer] error event');
            });

            processQueue();
        });
    }

    function clearMediaPipeline(message) {
        queue = [];
        hasPlayed = false;
        shouldAutoPlay = false;
        playbackMode = 'idle';
        resetFixedLatencySession('stopped');

        try { video.pause(); } catch (e) { }
        try {
            if (sourceBuffer && sourceBuffer.updating && typeof sourceBuffer.abort === 'function') {
                sourceBuffer.abort();
            }
        } catch (e) { }

        sourceBuffer = null;
        mediaSource = null;

        if (objectUrl) {
            try { URL.revokeObjectURL(objectUrl); } catch (e) { }
            objectUrl = null;
        }

        try {
            video.removeAttribute('src');
            video.load();
        } catch (e) { }

        video.playbackRate = 1;
        overlay.classList.remove('hidden');
        setConnectStatus(message || 'Stopped - waiting for stream...');
    }

    function resetForSyncedVideo(autoPlay, mode) {
        createMediaPipeline(
            !!autoPlay,
            fixedLatency.enabled && mode === 'desktop' ? 'Buffering fixed TV delay...' : 'Buffering synced video...',
            mode || 'file'
        );
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
            if (syncStateTimer) clearInterval(syncStateTimer);
            if (fixedLatencyTimer) clearInterval(fixedLatencyTimer);
            evictTimer = setInterval(evictBuffer, 20000);
            syncStateTimer = setInterval(sendSyncState, 1000);
            fixedLatencyTimer = setInterval(runFixedLatencyController, 250);
        };

        ws.onmessage = function (event) {
            if (typeof event.data === 'string') {
                handleControlMessage(event.data);
                return;
            }

            queue.push(event.data);
            processQueue();
            runFixedLatencyController();

            if (!fixedLatency.enabled && shouldAutoPlay && !overlay.classList.contains('hidden')) {
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
            resetForSyncedVideo(msg.autoPlay, msg.mode);
        } else if (msg.type === 'stop') {
            clearMediaPipeline('Stopped - waiting for stream...');
        } else if (msg.type === 'play') {
            if (fixedLatency.enabled && !fixedLatency.started) {
                shouldAutoPlay = false;
                runFixedLatencyController();
            } else {
                shouldAutoPlay = true;
                overlay.classList.add('hidden');
                playVideo();
            }
        } else if (msg.type === 'pause') {
            video.pause();
        } else if (msg.type === 'setPlaybackRate') {
            var rate = Number(msg.rate);
            if (rate >= 0.5 && rate <= 2) {
                video.playbackRate = rate;
            }
        } else if (msg.type === 'fixedLatency') {
            if (msg.mode === 'file') playbackMode = 'file';
            applyFixedLatencyOptions(msg.options);
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

        if (!hasPlayed && shouldAutoPlay && !fixedLatency.enabled) {
            hasPlayed = true;
            playVideo();
        }
    }

    function applyFixedLatencyOptions(options) {
        var wasEnabled = fixedLatency.enabled;
        var normalized = normalizeFixedLatencyOptions(options);
        fixedLatency.enabled = playbackMode === 'file' ? false : normalized.enabled;
        fixedLatency.targetSeconds = normalized.targetSeconds;
        fixedLatency.minBufferSeconds = normalized.minBufferSeconds;

        if (fixedLatency.enabled) {
            shouldAutoPlay = false;
            if (!wasEnabled) resetFixedLatencySession('enabled');
            runFixedLatencyController();
        } else {
            fixedLatency.started = false;
            fixedLatency.lastAction = 'disabled';
            fixedLatency.lastActionAt = Date.now();
            shouldAutoPlay = true;
            video.playbackRate = 1;
        }

    }

    function getBufferedEnd() {
        try {
            if (video.buffered.length > 0) {
                return video.buffered.end(video.buffered.length - 1);
            }
        } catch (e) { }

        return 0;
    }

    function getBufferAhead() {
        return Math.max(0, getBufferedEnd() - (Number(video.currentTime) || 0));
    }

    function setFixedLatencyAction(action, data, throttleMs) {
        var now = Date.now();
        if (fixedLatency.lastAction === action && now - fixedLatency.lastActionAt < (throttleMs || 1000)) {
            return;
        }

        fixedLatency.lastAction = action;
        fixedLatency.lastActionAt = now;
    }

    function setVideoRate(rate) {
        if (Math.abs((Number(video.playbackRate) || 1) - rate) > 0.005) {
            video.playbackRate = rate;
        }
    }

    function seekToFixedLatencyTarget(bufferedEnd, target, reason, data) {
        var now = Date.now();
        if (now - fixedLatency.lastSeekAt < 900) return false;

        try {
            video.currentTime = Math.max(0, bufferedEnd - target);
            fixedLatency.lastSeekAt = now;
            setVideoRate(1);
            setFixedLatencyAction(reason, data || {}, 0);
            return true;
        } catch (e) {
            return false;
        }
    }

    function runFixedLatencyController() {
        if (playbackMode !== 'desktop') return;
        if (!fixedLatency.enabled || !video || !mediaSource) return;

        var bufferedEnd = getBufferedEnd();
        var currentTime = Number(video.currentTime) || 0;
        var bufferAhead = Math.max(0, bufferedEnd - currentTime);
        var target = fixedLatency.targetSeconds;
        var startThreshold = Math.max(target, fixedLatency.minBufferSeconds);

        if (!bufferedEnd) {
            if (!fixedLatency.started) {
                overlay.classList.remove('hidden');
                setConnectStatus('Buffering fixed TV delay...');
            }
            return;
        }

        if (!fixedLatency.started) {
            if (bufferAhead < startThreshold) {
                try { video.pause(); } catch (e) { }
                overlay.classList.remove('hidden');
                setConnectStatus(
                    'Buffering fixed TV delay ' +
                    bufferAhead.toFixed(1) + ' / ' +
                    startThreshold.toFixed(1) + 's'
                );
                setFixedLatencyAction('waiting', { startThreshold: startThreshold }, 1500);
                return;
            }

            if (bufferAhead > target + 0.2) {
                seekToFixedLatencyTarget(bufferedEnd, target, 'initial_pin_to_target', {
                    error: bufferAhead - target
                });
                currentTime = Number(video.currentTime) || currentTime;
                bufferAhead = Math.max(0, bufferedEnd - currentTime);
            }

            fixedLatency.started = true;
            hasPlayed = true;
            overlay.classList.add('hidden');
            setConnectStatus('Playing with fixed TV delay...');
            setVideoRate(1);
            setFixedLatencyAction('start', { bufferAhead: bufferAhead }, 0);
            playVideo();
            return;
        }

        var error = bufferAhead - target;

        if (error > 0.35) {
            if (seekToFixedLatencyTarget(bufferedEnd, target, 'pin_to_target', { error: error })) {
                if (video.paused) playVideo();
                return;
            }
        }

        if (error < -0.85) {
            try { video.pause(); } catch (e) { }
            setVideoRate(1);
            setFixedLatencyAction('hold_for_buffer', { error: error }, 750);
            return;
        }

        if (error > 0.18) {
            setVideoRate(1.04);
            setFixedLatencyAction('speed_up', { error: error }, 1000);
            if (video.paused) playVideo();
            return;
        }

        if (error < -0.18) {
            setVideoRate(0.97);
            setFixedLatencyAction('slow_down', { error: error }, 1000);
            if (video.paused) playVideo();
            return;
        }

        setVideoRate(1);
        setFixedLatencyAction('on_target', { error: error }, 2000);
        if (video.paused) playVideo();
    }

    function playVideo() {
        video.play().catch(function () {
            video.muted = true;
            video.play().catch(function () { });
        });
    }

    function sendSyncState() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        var bufferedEnd = getBufferedEnd();
        var bufferAhead = Math.max(0, bufferedEnd - (Number(video.currentTime) || 0));

        ws.send(JSON.stringify({
            type: 'sync_state',
            currentTime: video.currentTime || 0,
            bufferedEnd: bufferedEnd,
            paused: video.paused,
            playbackRate: video.playbackRate || 1,
            queueLength: queue.length,
            readyState: video.readyState,
            fixedLatency: {
                enabled: fixedLatency.enabled,
                playbackMode: playbackMode,
                targetSeconds: fixedLatency.targetSeconds,
                minBufferSeconds: fixedLatency.minBufferSeconds,
                started: fixedLatency.started,
                bufferAheadSeconds: roundSeconds(bufferAhead),
                lastAction: fixedLatency.lastAction,
                lastActionAt: fixedLatency.lastActionAt
            }
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
        if (syncStateTimer) { clearInterval(syncStateTimer); syncStateTimer = null; }
        if (fixedLatencyTimer) { clearInterval(fixedLatencyTimer); fixedLatencyTimer = null; }
        if (ws) { try { ws.close(); } catch (e) { } ws = null; }
        queue = [];
        sourceBuffer = null;
        mediaSource = null;
        hasPlayed = false;
    }
})();

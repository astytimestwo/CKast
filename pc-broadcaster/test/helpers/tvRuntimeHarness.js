const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createTvRuntime() {
    const intervals = [];
    const mediaSources = [];
    const sockets = [];
    const bodyListeners = {};
    let activeElement = null;
    const classList = {
        add() {},
        remove() {},
        contains() { return false; }
    };

    let playCalls = 0;
    let pauseCalls = 0;
    const video = {
        currentTime: 0,
        paused: true,
        playbackRate: 1,
        readyState: 4,
        muted: true,
        buffered: {
            length: 0,
            start() { return 0; },
            end() { return 0; }
        },
        style: {},
        removeAttribute() {},
        load() {},
        pause() {
            pauseCalls += 1;
            this.paused = true;
        },
        play() {
            playCalls += 1;
            this.paused = false;
            return Promise.resolve();
        }
    };

    const formListeners = {};
    const elements = {
        screenVideo: video,
        connectOverlay: { classList },
        serverForm: {
            addEventListener(name, listener) { formListeners[name] = listener; }
        },
        serverIpInput: { value: '' },
        connectButton: {},
        connectStatusText: { textContent: '' }
    };
    elements.serverIpInput.focus = function () { activeElement = this; };
    elements.serverIpInput.blur = function () {
        if (activeElement === this) activeElement = null;
    };
    elements.connectButton.focus = function () { activeElement = this; };
    elements.connectButton.blur = function () {
        if (activeElement === this) activeElement = null;
    };

    class FakeSourceBuffer {
        constructor() {
            this.updating = false;
            this.mode = '';
            this.listeners = {};
            this.appended = [];
            this.removed = [];
            this.buffered = {
                length: 1,
                start() { return 0; }
            };
        }

        addEventListener(name, listener) {
            this.listeners[name] = listener;
        }

        appendBuffer(chunk) {
            this.appended.push(chunk);
        }

        abort() {}

        remove(start, end) {
            this.removed.push([start, end]);
        }
    }

    class FakeMediaSource {
        constructor() {
            this.listeners = {};
            this.opened = false;
            this.addSourceBufferCalls = 0;
            this.sourceBuffers = [];
            mediaSources.push(this);
        }

        addEventListener(name, listener) {
            this.listeners[name] = listener;
        }

        addSourceBuffer() {
            this.addSourceBufferCalls += 1;
            if (!this.opened) throw new Error('MediaSource not open');
            const sourceBuffer = new FakeSourceBuffer();
            this.sourceBuffers.push(sourceBuffer);
            return sourceBuffer;
        }
    }

    class FakeWebSocket {
        constructor() {
            this.readyState = FakeWebSocket.OPEN;
            this.sent = [];
            this.closed = null;
            this.throwOnSend = false;
            sockets.push(this);
        }

        send(payload) {
            if (this.throwOnSend) throw new Error('socket closing');
            this.sent.push(payload);
        }

        close(code, reason) {
            this.readyState = FakeWebSocket.CLOSED;
            this.closed = { code, reason };
        }
    }
    FakeWebSocket.OPEN = 1;
    FakeWebSocket.CLOSED = 3;

    const context = {
        console,
        ArrayBuffer,
        Buffer,
        Date,
        JSON,
        Math,
        Number,
        Object,
        Promise,
        String,
        document: {
            get activeElement() { return activeElement; },
            body: {
                addEventListener(name, listener) { bodyListeners[name] = listener; }
            },
            getElementById(id) { return elements[id]; }
        },
        localStorage: {
            getItem() { return ''; },
            setItem() {}
        },
        MediaSource: FakeMediaSource,
        WebSocket: FakeWebSocket,
        URL: {
            createObjectURL() { return 'blob:ckast'; },
            revokeObjectURL() {}
        },
        setInterval(listener) {
            intervals.push(listener);
            return intervals.length;
        },
        clearInterval() {},
        setTimeout() { return 1; },
        clearTimeout() {}
    };

    const scriptPath = path.join(__dirname, '../../../tv-app/js/main.js');
    vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);

    return {
        elements,
        intervals,
        mediaSources,
        sockets,
        video,
        get playCalls() { return playCalls; },
        get pauseCalls() { return pauseCalls; },
        get socket() { return sockets[sockets.length - 1]; },
        get currentMediaSource() { return mediaSources[mediaSources.length - 1]; },
        get activeElement() { return activeElement; },
        keyDown(keyCode) {
            let defaultPrevented = false;
            if (bodyListeners.keydown) {
                bodyListeners.keydown({
                    keyCode,
                    preventDefault() { defaultPrevented = true; }
                });
            }
            return { defaultPrevented };
        },
        submitAddressForm() {
            if (formListeners.submit) {
                formListeners.submit({ preventDefault() {} });
            }
        },
        sendControl(payload) {
            this.socket.onmessage({ data: JSON.stringify(payload) });
        },
        sendBinary(size = 8) {
            this.socket.onmessage({ data: new ArrayBuffer(size) });
        },
        openMediaSource(mediaSource = this.currentMediaSource) {
            mediaSource.opened = true;
            mediaSource.listeners.sourceopen();
            return mediaSource.sourceBuffers[mediaSource.sourceBuffers.length - 1];
        }
    };
}

module.exports = {
    createTvRuntime
};

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PIPE_CONNECT_TIMEOUT_MS = 8000;
const PIPE_RETRY_MS = 120;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function resolveMpvPath() {
    if (process.env.MPV_PATH) {
        return {
            command: process.env.MPV_PATH,
            source: 'MPV_PATH',
            exists: fs.existsSync(process.env.MPV_PATH)
        };
    }

    const bundled = path.join(__dirname, '..', 'vendor', 'mpv', 'mpv.exe');
    if (fs.existsSync(bundled)) {
        return {
            command: bundled,
            source: 'bundled',
            exists: true
        };
    }

    const localRelease = path.join(
        __dirname,
        '..',
        '..',
        'mpv-v0.41.0-x86_64-pc-windows-msvc',
        'mpv.exe'
    );
    if (fs.existsSync(localRelease)) {
        return {
            command: localRelease,
            source: 'local-release',
            exists: true
        };
    }

    return {
        command: 'mpv',
        source: 'PATH',
        exists: null
    };
}

class MpvController extends EventEmitter {
    constructor() {
        super();
        this.process = null;
        this.socket = null;
        this.pipePath = null;
        this.buffer = '';
        this.nextRequestId = 1;
        this.pending = new Map();
        this.state = {
            filePath: null,
            running: false,
            connected: false,
            loaded: false,
            paused: true,
            timePos: 0,
            duration: 0,
            volume: 100,
            mpvPath: resolveMpvPath(),
            error: null
        };
    }

    getStatus() {
        return {
            ...this.state,
            hasProcess: !!this.process,
            hasSocket: !!this.socket
        };
    }

    async open(filePath) {
        const normalizedPath = path.resolve(filePath || '');
        if (!fs.existsSync(normalizedPath)) {
            throw new Error('Media file not found: ' + normalizedPath);
        }

        if (!this.process) {
            await this.startProcess();
        }

        await this.command(['set_property', 'pause', true]);
        await this.command(['loadfile', normalizedPath, 'replace']);

        this.state.filePath = normalizedPath;
        this.state.loaded = true;
        this.state.paused = true;
        this.state.timePos = 0;
        this.state.error = null;

        await this.refreshCoreProperties();
        return this.getStatus();
    }

    async play() {
        this.assertReady();
        await this.command(['set_property', 'pause', false]);
        this.state.paused = false;
        return this.getStatus();
    }

    async pause() {
        this.assertReady();
        await this.command(['set_property', 'pause', true]);
        this.state.paused = true;
        return this.getStatus();
    }

    async seek(timeSeconds) {
        this.assertReady();
        const target = Number(timeSeconds);
        if (!Number.isFinite(target) || target < 0) {
            throw new Error('Seek time must be a non-negative number');
        }

        await this.command(['seek', target, 'absolute+exact']);
        this.state.timePos = target;
        return this.getStatus();
    }

    async setVolume(volume) {
        this.assertProcess();
        const nextVolume = clamp(Number(volume), 0, 100);
        await this.command(['set_property', 'volume', nextVolume]);
        this.state.volume = nextVolume;
        return this.getStatus();
    }

    async refreshCoreProperties() {
        if (!this.socket) return this.getStatus();

        const [timePos, duration, paused, volume] = await Promise.allSettled([
            this.command(['get_property', 'time-pos']),
            this.command(['get_property', 'duration']),
            this.command(['get_property', 'pause']),
            this.command(['get_property', 'volume'])
        ]);

        if (timePos.status === 'fulfilled' && Number.isFinite(timePos.value)) {
            this.state.timePos = timePos.value;
        }
        if (duration.status === 'fulfilled' && Number.isFinite(duration.value)) {
            this.state.duration = duration.value;
        }
        if (paused.status === 'fulfilled' && typeof paused.value === 'boolean') {
            this.state.paused = paused.value;
        }
        if (volume.status === 'fulfilled' && Number.isFinite(volume.value)) {
            this.state.volume = volume.value;
        }

        return this.getStatus();
    }

    async stop() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('MPV stopped'));
        }
        this.pending.clear();

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        if (this.process) {
            this.process.kill();
            this.process = null;
        }

        this.state.running = false;
        this.state.connected = false;
        this.state.loaded = false;
        this.state.paused = true;
        this.state.timePos = 0;
        this.state.duration = 0;
        this.state.filePath = null;

        return this.getStatus();
    }

    async startProcess() {
        const mpvPath = resolveMpvPath();
        this.state.mpvPath = mpvPath;

        if (mpvPath.exists === false) {
            throw new Error('MPV executable was not found at ' + mpvPath.command);
        }

        this.pipePath = '\\\\.\\pipe\\ckast-mpv-' + process.pid + '-' + Date.now();
        const args = [
            '--idle=yes',
            '--force-window=no',
            '--video=no',
            '--pause=yes',
            '--input-terminal=no',
            '--terminal=no',
            '--input-ipc-server=' + this.pipePath
        ];

        this.process = spawn(mpvPath.command, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });

        this.state.running = true;
        this.state.error = null;

        this.process.once('error', (err) => {
            this.state.error = err.message;
            this.state.running = false;
            this.state.connected = false;
            this.process = null;
            this.emit('error', err);
        });

        this.process.stderr.on('data', (chunk) => {
            const message = chunk.toString().trim();
            if (message) this.emit('log', message);
        });

        this.process.once('exit', (code) => {
            this.process = null;
            this.state.running = false;
            this.state.connected = false;
            this.state.loaded = false;
            if (this.socket) {
                this.socket.destroy();
                this.socket = null;
            }
            if (code !== 0 && code !== null) {
                this.state.error = 'MPV exited with code ' + code;
            }
        });

        await this.connectPipe();
        await this.observeProperties();
    }

    connectPipe() {
        const startedAt = Date.now();

        return new Promise((resolve, reject) => {
            const tryConnect = () => {
                if (!this.process) {
                    reject(new Error('MPV exited before IPC was ready'));
                    return;
                }

                const socket = net.connect(this.pipePath);

                socket.once('connect', () => {
                    this.socket = socket;
                    this.state.connected = true;
                    this.attachSocketHandlers(socket);
                    resolve();
                });

                socket.once('error', (err) => {
                    socket.destroy();
                    if (Date.now() - startedAt > PIPE_CONNECT_TIMEOUT_MS) {
                        reject(new Error('Could not connect to MPV IPC pipe: ' + err.message));
                        return;
                    }
                    setTimeout(tryConnect, PIPE_RETRY_MS);
                });
            };

            tryConnect();
        });
    }

    attachSocketHandlers(socket) {
        socket.on('data', (chunk) => {
            this.buffer += chunk.toString('utf8');
            let newlineIndex = this.buffer.indexOf('\n');

            while (newlineIndex !== -1) {
                const line = this.buffer.slice(0, newlineIndex).trim();
                this.buffer = this.buffer.slice(newlineIndex + 1);
                if (line) this.handleMessage(line);
                newlineIndex = this.buffer.indexOf('\n');
            }
        });

        socket.on('close', () => {
            this.state.connected = false;
            this.socket = null;
        });
    }

    handleMessage(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (err) {
            this.emit('log', 'Invalid MPV IPC message: ' + line);
            return;
        }

        if (message.event === 'property-change') {
            this.applyPropertyChange(message);
            return;
        }

        if (message.request_id && this.pending.has(message.request_id)) {
            const pending = this.pending.get(message.request_id);
            this.pending.delete(message.request_id);
            clearTimeout(pending.timeout);

            if (message.error === 'success') {
                pending.resolve(message.data);
            } else {
                pending.reject(new Error(message.error || 'MPV command failed'));
            }
        }
    }

    applyPropertyChange(message) {
        if (message.name === 'time-pos' && Number.isFinite(message.data)) {
            this.state.timePos = message.data;
        } else if (message.name === 'duration' && Number.isFinite(message.data)) {
            this.state.duration = message.data;
        } else if (message.name === 'pause' && typeof message.data === 'boolean') {
            this.state.paused = message.data;
        } else if (message.name === 'volume' && Number.isFinite(message.data)) {
            this.state.volume = message.data;
        }
    }

    async observeProperties() {
        await this.command(['observe_property', 1, 'time-pos']);
        await this.command(['observe_property', 2, 'duration']);
        await this.command(['observe_property', 3, 'pause']);
        await this.command(['observe_property', 4, 'volume']);
    }

    command(command) {
        this.assertProcess();
        if (!this.socket) {
            return Promise.reject(new Error('MPV IPC is not connected'));
        }

        const requestId = this.nextRequestId++;
        const payload = JSON.stringify({ command, request_id: requestId }) + '\n';

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('MPV command timed out: ' + command[0]));
            }, 5000);

            this.pending.set(requestId, { resolve, reject, timeout });
            this.socket.write(payload, 'utf8');
        });
    }

    assertProcess() {
        if (!this.process) {
            throw new Error('MPV is not running. Open a media file first.');
        }
    }

    assertReady() {
        this.assertProcess();
        if (!this.state.loaded) {
            throw new Error('No media file is loaded.');
        }
    }
}

module.exports = {
    MpvController,
    resolveMpvPath
};

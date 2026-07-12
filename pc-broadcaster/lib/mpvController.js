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

function buildMpvArgs(pipePath) {
    return [
        '--idle=yes',
        '--force-window=yes',
        '--pause=yes',
        '--input-terminal=no',
        '--terminal=no',
        '--input-ipc-server=' + pipePath
    ];
}

function parseAudioTrackId(value) {
    if (value === null || value === undefined || value === false || value === 'no' || value === 'auto') {
        return null;
    }
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeAudioTracks(trackList, selectedAudioTrackId) {
    const selectedId = parseAudioTrackId(selectedAudioTrackId);
    const hasSelectedId = selectedId !== null;

    return (Array.isArray(trackList) ? trackList : [])
        .filter((track) => track && track.type === 'audio' && Number.isInteger(Number(track.id)))
        .map((track) => {
            const id = Number(track.id);
            return {
                id,
                language: track.lang || '',
                title: track.title || '',
                codec: track.codec || '',
                channels: Number(track['demux-channel-count'] || track.channels) || 0,
                selected: hasSelectedId ? id === selectedId : !!track.selected
            };
        });
}

class MpvController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.spawnProcess = options.spawnProcess || spawn;
        this.connectSocket = options.connectSocket || net.connect;
        this.pipeConnectTimeoutMs = options.pipeConnectTimeoutMs || PIPE_CONNECT_TIMEOUT_MS;
        this.pipeRetryMs = options.pipeRetryMs || PIPE_RETRY_MS;
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
            audioDelay: 0,
            audioTracks: [],
            selectedAudioTrackId: null,
            speed: 1,
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
        await this.command(['set_property', 'speed', 1]);
        this.state.audioTracks = [];
        this.state.selectedAudioTrackId = null;
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

    async setSpeed(speed) {
        this.assertReady();
        const nextSpeed = clamp(Number(speed), 0.9, 1.1);
        if (!Number.isFinite(nextSpeed)) {
            throw new Error('Speed must be a number');
        }

        await this.command(['set_property', 'speed', nextSpeed]);
        this.state.speed = nextSpeed;
        return this.getStatus();
    }

    async setVolume(volume) {
        this.assertProcess();
        const nextVolume = clamp(Number(volume), 0, 100);
        await this.command(['set_property', 'volume', nextVolume]);
        this.state.volume = nextVolume;
        return this.getStatus();
    }

    async setAudioDelay(delaySeconds) {
        this.assertReady();
        const nextDelay = clamp(Number(delaySeconds), -2, 10);
        if (!Number.isFinite(nextDelay)) {
            throw new Error('Audio delay must be a number');
        }

        await this.command(['set_property', 'audio-delay', nextDelay]);
        this.state.audioDelay = nextDelay;
        return this.getStatus();
    }

    async setAudioTrack(audioTrackId) {
        this.assertReady();
        const nextTrackId = parseAudioTrackId(audioTrackId);
        if (nextTrackId === null) {
            throw new Error('Audio track ID must be a positive integer');
        }
        if (!this.state.audioTracks.some((track) => track.id === nextTrackId)) {
            throw new Error(`Audio track ${nextTrackId} is not available`);
        }

        await this.command(['set_property', 'aid', nextTrackId]);
        this.state.selectedAudioTrackId = nextTrackId;
        this.state.audioTracks = this.state.audioTracks.map((track) => ({
            ...track,
            selected: track.id === nextTrackId
        }));
        return this.getStatus();
    }

    async refreshCoreProperties() {
        if (!this.socket) return this.getStatus();

        const [timePos, duration, paused, volume, audioDelay, speed, trackList, audioTrackId] = await Promise.allSettled([
            this.command(['get_property', 'time-pos']),
            this.command(['get_property', 'duration']),
            this.command(['get_property', 'pause']),
            this.command(['get_property', 'volume']),
            this.command(['get_property', 'audio-delay']),
            this.command(['get_property', 'speed']),
            this.command(['get_property', 'track-list']),
            this.command(['get_property', 'aid'])
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
        if (audioDelay.status === 'fulfilled' && Number.isFinite(audioDelay.value)) {
            this.state.audioDelay = audioDelay.value;
        }
        if (speed.status === 'fulfilled' && Number.isFinite(speed.value)) {
            this.state.speed = speed.value;
        }
        if (audioTrackId.status === 'fulfilled') {
            this.state.selectedAudioTrackId = parseAudioTrackId(audioTrackId.value);
        }
        if (trackList.status === 'fulfilled') {
            this.state.audioTracks = normalizeAudioTracks(
                trackList.value,
                this.state.selectedAudioTrackId
            );
            if (this.state.selectedAudioTrackId === null) {
                const selectedTrack = this.state.audioTracks.find((track) => track.selected);
                this.state.selectedAudioTrackId = selectedTrack ? selectedTrack.id : null;
            }
        } else if (audioTrackId.status === 'fulfilled') {
            this.state.audioTracks = this.state.audioTracks.map((track) => ({
                ...track,
                selected: track.id === this.state.selectedAudioTrackId
            }));
        }

        return this.getStatus();
    }

    async stop() {
        this.rejectPending(new Error('MPV stopped'));

        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            socket.destroy();
        }

        if (this.process) {
            const mpvProcess = this.process;
            this.process = null;
            mpvProcess.kill();
        }

        this.buffer = '';

        this.state.running = false;
        this.state.connected = false;
        this.state.loaded = false;
        this.state.paused = true;
        this.state.timePos = 0;
        this.state.duration = 0;
        this.state.audioDelay = 0;
        this.state.audioTracks = [];
        this.state.selectedAudioTrackId = null;
        this.state.speed = 1;
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
        const args = buildMpvArgs(this.pipePath);

        const mpvProcess = this.spawnProcess(mpvPath.command, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        this.process = mpvProcess;

        this.state.running = true;
        this.state.error = null;

        mpvProcess.once('error', (err) => {
            if (this.process !== mpvProcess) return;
            this.state.error = err.message;
            this.state.running = false;
            this.state.connected = false;
            this.process = null;
            this.rejectPending(err);
            this.emit('error', err);
        });

        mpvProcess.stderr.on('data', (chunk) => {
            const message = chunk.toString().trim();
            if (message) this.emit('log', message);
        });

        mpvProcess.once('exit', (code) => {
            if (this.process !== mpvProcess) return;
            this.process = null;
            this.state.running = false;
            this.state.connected = false;
            this.state.loaded = false;
            this.rejectPending(new Error('MPV exited'));
            if (this.socket) {
                const socket = this.socket;
                this.socket = null;
                socket.destroy();
            }
            this.buffer = '';
            if (code !== 0 && code !== null) {
                this.state.error = 'MPV exited with code ' + code;
            }
        });

        try {
            await this.connectPipe();
            await this.observeProperties();
        } catch (err) {
            if (this.process === mpvProcess) {
                this.process = null;
                this.state.running = false;
                this.state.connected = false;
                this.state.loaded = false;
                this.state.error = err.message;
                this.rejectPending(err);
                if (this.socket) {
                    const socket = this.socket;
                    this.socket = null;
                    socket.destroy();
                }
                this.buffer = '';
                mpvProcess.kill();
            }
            throw err;
        }
    }

    connectPipe() {
        const startedAt = Date.now();

        return new Promise((resolve, reject) => {
            const tryConnect = () => {
                if (!this.process) {
                    reject(new Error('MPV exited before IPC was ready'));
                    return;
                }

                const socket = this.connectSocket(this.pipePath);

                socket.once('connect', () => {
                    this.socket = socket;
                    this.state.connected = true;
                    this.attachSocketHandlers(socket);
                    resolve();
                });

                socket.once('error', (err) => {
                    socket.destroy();
                    if (Date.now() - startedAt > this.pipeConnectTimeoutMs) {
                        reject(new Error('Could not connect to MPV IPC pipe: ' + err.message));
                        return;
                    }
                    setTimeout(tryConnect, this.pipeRetryMs);
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
            if (this.socket !== socket) return;
            this.state.connected = false;
            this.socket = null;
            this.rejectPending(new Error('MPV IPC connection closed'));
            this.buffer = '';
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
        } else if (message.name === 'audio-delay' && Number.isFinite(message.data)) {
            this.state.audioDelay = message.data;
        } else if (message.name === 'speed' && Number.isFinite(message.data)) {
            this.state.speed = message.data;
        } else if (message.name === 'track-list') {
            this.state.audioTracks = normalizeAudioTracks(
                message.data,
                this.state.selectedAudioTrackId
            );
            const selectedTrack = this.state.audioTracks.find((track) => track.selected);
            this.state.selectedAudioTrackId = selectedTrack ? selectedTrack.id : null;
        } else if (message.name === 'aid') {
            this.state.selectedAudioTrackId = parseAudioTrackId(message.data);
            this.state.audioTracks = this.state.audioTracks.map((track) => ({
                ...track,
                selected: track.id === this.state.selectedAudioTrackId
            }));
        }
    }

    async observeProperties() {
        await this.command(['observe_property', 1, 'time-pos']);
        await this.command(['observe_property', 2, 'duration']);
        await this.command(['observe_property', 3, 'pause']);
        await this.command(['observe_property', 4, 'volume']);
        await this.command(['observe_property', 5, 'audio-delay']);
        await this.command(['observe_property', 6, 'speed']);
        await this.command(['observe_property', 7, 'track-list']);
        await this.command(['observe_property', 8, 'aid']);
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

    rejectPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
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
    buildMpvArgs,
    MpvController,
    normalizeAudioTracks,
    resolveMpvPath
};

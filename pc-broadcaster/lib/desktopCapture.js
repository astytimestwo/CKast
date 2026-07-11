const EventEmitter = require('events');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');
const { resolveFfmpegPath } = require('./fileVideoStreamer');

const DEFAULT_WATCHDOG_MS = 5000;

function buildDesktopFfmpegArgs() {
    return [
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
}

class DesktopCapture extends EventEmitter {
    constructor(options = {}) {
        super();
        this.spawnProcess = options.spawnProcess || spawn;
        this.mp4fragFactory = options.mp4fragFactory || (() => new Mp4Frag());
        this.ffmpegCommand = options.ffmpegCommand || resolveFfmpegPath();
        this.watchdogMs = options.watchdogMs || DEFAULT_WATCHDOG_MS;
        this.process = null;
        this.mp4frag = null;
        this.initSegment = null;
        this.sendSegment = null;
        this.watchdog = null;
        this.mode = 'idle';
        this.error = null;
        this.lastSegmentAt = null;
    }

    getStatus() {
        return {
            active: !!this.process,
            mode: this.mode,
            ffmpegPid: this.process ? this.process.pid : null,
            hasInitSegment: !!this.initSegment,
            lastSegmentAt: this.lastSegmentAt,
            error: this.error,
            ffmpegPath: this.ffmpegCommand,
            watchdogArmed: !!this.watchdog
        };
    }

    start(sendSegment) {
        this.stop();
        this.sendSegment = sendSegment;
        this.mode = 'starting';
        this.error = null;
        this.lastSegmentAt = null;

        const mp4frag = this.mp4fragFactory();
        this.mp4frag = mp4frag;

        mp4frag.on('initialized', (data) => {
            if (this.mp4frag !== mp4frag) return;
            this.initSegment = data.initialization;
            this.mode = 'streaming';
            this.emit('initialized', this.initSegment);
            this.safeSend(this.initSegment);
            this.armWatchdog(this.process);
        });

        mp4frag.on('segment', (data) => {
            if (this.mp4frag !== mp4frag) return;
            this.lastSegmentAt = Date.now();
            this.emit('segment', {
                bytes: data.segment ? data.segment.length : 0,
                at: this.lastSegmentAt
            });
            this.safeSend(data.segment);
            this.armWatchdog(this.process);
        });

        mp4frag.on('error', (err) => {
            if (this.mp4frag !== mp4frag) return;
            this.error = err.message;
            this.mode = 'error';
            this.emit('error', err);
        });

        const ffmpegProcess = this.spawnProcess(
            this.ffmpegCommand,
            buildDesktopFfmpegArgs(),
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        this.process = ffmpegProcess;
        ffmpegProcess.stdout.pipe(mp4frag);
        this.armWatchdog(ffmpegProcess);

        ffmpegProcess.stderr.on('data', (chunk) => {
            // Always drain stderr so FFmpeg cannot block on a full pipe.
            chunk.length;
        });

        ffmpegProcess.once('error', (err) => {
            if (this.process !== ffmpegProcess) return;
            this.error = err.message;
            this.mode = 'error';
            this.emit('error', err);
        });

        ffmpegProcess.once('close', (code) => {
            if (this.process !== ffmpegProcess) return;
            this.process = null;
            if (this.mode !== 'idle') {
                this.mode = code === 0 ? 'ended' : 'error';
                if (code !== 0 && code !== null && !this.error) {
                    this.error = 'FFmpeg exited with code ' + code;
                }
            }
            this.emit('close', { code, mode: this.mode, error: this.error });
        });

        return this.getStatus();
    }

    stop() {
        this.clearWatchdog();
        this.mode = 'idle';

        if (this.process) {
            const ffmpegProcess = this.process;
            this.process = null;
            ffmpegProcess.kill('SIGKILL');
        }
        if (this.mp4frag) {
            this.mp4frag.removeAllListeners();
            this.mp4frag = null;
        }

        this.initSegment = null;
        this.lastSegmentAt = null;
        return this.getStatus();
    }

    armWatchdog(process) {
        this.clearWatchdog();
        this.watchdog = setTimeout(() => {
            this.watchdog = null;
            if (this.mode === 'idle') return;
            if (this.process && this.process !== process) return;
            this.emit('restart', { reason: 'watchdog' });
            this.start(this.sendSegment);
        }, this.watchdogMs);
    }

    clearWatchdog() {
        if (this.watchdog) {
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
    }

    safeSend(chunk) {
        if (typeof this.sendSegment !== 'function') return;
        try {
            this.sendSegment(chunk);
        } catch (err) {
            this.error = err.message;
            this.emit('error', err);
        }
    }
}

module.exports = {
    buildDesktopFfmpegArgs,
    DesktopCapture
};

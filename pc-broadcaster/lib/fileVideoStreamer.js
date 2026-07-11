const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Mp4Frag = require('mp4frag');

function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH) {
        return process.env.FFMPEG_PATH;
    }
    return 'ffmpeg';
}

function escapeFilterPath(filePath) {
    return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function formatSrtTime(totalMs) {
    const clamped = Math.max(0, Math.round(totalMs));
    const hours = Math.floor(clamped / 3600000);
    const minutes = Math.floor((clamped % 3600000) / 60000);
    const seconds = Math.floor((clamped % 60000) / 1000);
    const millis = clamped % 1000;

    return [
        String(hours).padStart(2, '0'),
        String(minutes).padStart(2, '0'),
        String(seconds).padStart(2, '0')
    ].join(':') + ',' + String(millis).padStart(3, '0');
}

function parseSrtTime(value) {
    const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
    if (!match) return null;
    return (
        Number(match[1]) * 3600000 +
        Number(match[2]) * 60000 +
        Number(match[3]) * 1000 +
        Number(match[4])
    );
}

function createShiftedSrt(sourcePath, delaySeconds) {
    if (!fs.existsSync(sourcePath)) {
        throw new Error('Subtitle file not found: ' + sourcePath);
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.srt' || !Number.isFinite(delaySeconds) || delaySeconds === 0) {
        return { filePath: sourcePath, temporary: false };
    }

    const runtimeDir = path.join(__dirname, '..', '.runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const shiftMs = delaySeconds * 1000;
    const source = fs.readFileSync(sourcePath, 'utf8');
    const shifted = source.replace(
        /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g,
        (line, start, end) => {
            const startMs = parseSrtTime(start);
            const endMs = parseSrtTime(end);
            if (startMs === null || endMs === null) return line;
            return formatSrtTime(startMs + shiftMs) + ' --> ' + formatSrtTime(endMs + shiftMs);
        }
    );

    const target = path.join(runtimeDir, 'shifted-subtitles-' + Date.now() + '.srt');
    fs.writeFileSync(target, shifted, 'utf8');
    return { filePath: target, temporary: true };
}

function buildSubtitleFilter(options, startTime = 0) {
    if (!options || options.subtitlesEnabled === false) return { filter: null, tempPath: null };

    const scale = Number(options.subtitleScale);
    const delay = Number(options.subtitleDelay);
    const forceStyleParts = [];

    if (Number.isFinite(scale) && scale > 0) {
        forceStyleParts.push('Fontsize=' + Math.round(42 * scale));
    }

    var subtitleFilter = null;
    var tempPath = null;

    if (options.externalSubtitlePath) {
        const subtitle = createShiftedSrt(path.resolve(options.externalSubtitlePath), delay);
        if (subtitle.temporary) tempPath = subtitle.filePath;
        subtitleFilter = "subtitles='" + escapeFilterPath(subtitle.filePath) + "'";
    } else if (Number.isInteger(options.subtitleStreamIndex) && options.subtitleStreamIndex >= 0) {
        subtitleFilter = "subtitles='" + escapeFilterPath(options.filePath) + "':si=" + options.subtitleStreamIndex;
    }

    if (!subtitleFilter) return { filter: null, tempPath: null };

    if (forceStyleParts.length > 0) {
        subtitleFilter += ":force_style='" + forceStyleParts.join(',') + "'";
    }

    const absoluteStartTime = Math.max(0, Number(startTime) || 0);
    if (absoluteStartTime > 0) {
        subtitleFilter = 'setpts=PTS+' + absoluteStartTime + '/TB,' +
            subtitleFilter + ',setpts=PTS-STARTPTS';
    }

    return { filter: subtitleFilter, tempPath };
}

class FileVideoStreamer extends EventEmitter {
    constructor() {
        super();
        this.ffmpegProcess = null;
        this.mp4frag = null;
        this.initSegment = null;
        this.filePath = null;
        this.streamStartTime = 0;
        this.mode = 'idle';
        this.error = null;
        this.lastSegmentAt = null;
        this.sendSegment = null;
        this.subtitleTempPath = null;
        this.options = {
            bitrateKbps: 16000,
            subtitleStreamIndex: -1,
            externalSubtitlePath: '',
            subtitleDelay: 0,
            subtitleScale: 1,
            subtitlesEnabled: false
        };
    }

    getStatus() {
        return {
            active: !!this.ffmpegProcess,
            playbackAvailable: !!this.filePath && ['starting', 'streaming', 'ended'].includes(this.mode),
            mode: this.mode,
            filePath: this.filePath,
            ffmpegPid: this.ffmpegProcess ? this.ffmpegProcess.pid : null,
            streamStartTime: this.streamStartTime,
            hasInitSegment: !!this.initSegment,
            lastSegmentAt: this.lastSegmentAt,
            error: this.error,
            ffmpegPath: resolveFfmpegPath(),
            options: { ...this.options }
        };
    }

    start(filePath, options) {
        const normalizedPath = path.resolve(filePath || '');
        if (!fs.existsSync(normalizedPath)) {
            throw new Error('Media file not found: ' + normalizedPath);
        }

        this.stop();

        const startTime = Math.max(0, Number(options && options.startTime) || 0);
        const bitrateKbps = Math.max(2000, Number(options && options.bitrateKbps) || this.options.bitrateKbps || 16000);
        this.options = {
            ...this.options,
            ...(options || {}),
            bitrateKbps,
            filePath: normalizedPath
        };

        this.filePath = normalizedPath;
        this.streamStartTime = startTime;
        this.mode = 'starting';
        this.error = null;
        this.lastSegmentAt = null;
        this.sendSegment = options && options.sendSegment;
        this.emit('start', {
            filePath: normalizedPath,
            startTime,
            bitrateKbps,
            subtitlesEnabled: !!this.options.subtitlesEnabled,
            subtitleStreamIndex: this.options.subtitleStreamIndex,
            hasExternalSubtitle: !!this.options.externalSubtitlePath
        });

        this.mp4frag = new Mp4Frag();
        this.mp4frag.on('initialized', (data) => {
            this.initSegment = data.initialization;
            this.mode = 'streaming';
            this.emit('initialized', this.initSegment);
            this.safeSend(this.initSegment);
        });

        this.mp4frag.on('segment', (data) => {
            this.lastSegmentAt = Date.now();
            this.emit('segment', {
                bytes: data.segment ? data.segment.length : 0,
                at: this.lastSegmentAt
            });
            this.safeSend(data.segment);
        });

        this.mp4frag.on('error', (err) => {
            this.error = err.message;
            this.emit('error', err);
        });

        this.cleanupSubtitleTemp();
        let subtitle;
        try {
            subtitle = buildSubtitleFilter(this.options, startTime);
        } catch (err) {
            this.filePath = null;
            this.mode = 'error';
            this.error = err.message;
            throw err;
        }
        this.subtitleTempPath = subtitle.tempPath;
        const videoFilters = [];
        if (subtitle.filter) videoFilters.push(subtitle.filter);

        const ffmpegArgs = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-ss', String(startTime),
            '-re',
            '-i', normalizedPath,
            '-an',
            '-map', '0:v:0',
            ...(videoFilters.length ? ['-vf', videoFilters.join(',')] : []),
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-profile:v', 'baseline',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p',
            '-bf', '0',
            '-g', '48',
            '-keyint_min', '48',
            '-sc_threshold', '0',
            '-b:v', bitrateKbps + 'k',
            '-maxrate', bitrateKbps + 'k',
            '-bufsize', bitrateKbps + 'k',
            '-f', 'mp4',
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
            'pipe:1'
        ];

        const ffmpegProcess = spawn(resolveFfmpegPath(), ffmpegArgs, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.ffmpegProcess = ffmpegProcess;
        this.emit('ffmpeg_spawn', {
            pid: ffmpegProcess.pid,
            command: resolveFfmpegPath(),
            args: ffmpegArgs
        });

        ffmpegProcess.stdout.pipe(this.mp4frag);

        ffmpegProcess.stderr.on('data', (chunk) => {
            const message = chunk.toString().trim();
            if (message) this.emit('log', message);
        });

        ffmpegProcess.once('error', (err) => {
            if (this.ffmpegProcess !== ffmpegProcess) return;
            this.error = err.message;
            this.mode = 'error';
            this.emit('error', err);
        });

        ffmpegProcess.once('close', (code) => {
            if (this.ffmpegProcess !== ffmpegProcess) return;
            if (this.mode !== 'idle' && code !== 0 && code !== null) {
                this.error = 'FFmpeg exited with code ' + code;
                this.mode = 'error';
            } else if (this.mode !== 'idle') {
                this.mode = 'ended';
            }
            this.emit('close', {
                code,
                mode: this.mode,
                error: this.error
            });
            this.ffmpegProcess = null;
        });

        return this.getStatus();
    }

    restartAt(startTime, options) {
        if (!this.filePath) {
            throw new Error('No media file is loaded for TV video streaming.');
        }

        return this.start(this.filePath, {
            ...(options || {}),
            startTime,
            sendSegment: this.sendSegment
        });
    }

    stop() {
        if (this.ffmpegProcess || this.filePath || this.mode !== 'idle') {
            this.emit('stop', {
                filePath: this.filePath,
                mode: this.mode,
                pid: this.ffmpegProcess ? this.ffmpegProcess.pid : null
            });
        }

        if (this.ffmpegProcess) {
            const ffmpegProcess = this.ffmpegProcess;
            this.ffmpegProcess = null;
            ffmpegProcess.kill('SIGKILL');
        }

        if (this.mp4frag) {
            this.mp4frag.removeAllListeners();
            this.mp4frag = null;
        }

        this.cleanupSubtitleTemp();
        this.initSegment = null;
        this.filePath = null;
        this.mode = 'idle';
        this.lastSegmentAt = null;
        return this.getStatus();
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

    cleanupSubtitleTemp() {
        if (this.subtitleTempPath) {
            try {
                if (fs.existsSync(this.subtitleTempPath)) fs.unlinkSync(this.subtitleTempPath);
            } catch (err) {
                this.emit('log', 'Could not remove temporary subtitle file: ' + err.message);
            }
        }
        this.subtitleTempPath = null;
    }
}

module.exports = {
    buildSubtitleFilter,
    FileVideoStreamer,
    resolveFfmpegPath
};

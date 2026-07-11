const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

class FakeProcess extends EventEmitter {
    constructor(pid) {
        super();
        this.pid = pid;
        this.killed = false;
        this.stdout = { pipe() {} };
        this.stderr = new EventEmitter();
    }

    kill() {
        this.killed = true;
        return true;
    }
}

function freshStreamerWithSpawn(fakeSpawn) {
    const childProcess = require('child_process');
    const originalSpawn = childProcess.spawn;
    const modulePath = require.resolve('../lib/fileVideoStreamer');

    childProcess.spawn = fakeSpawn;
    delete require.cache[modulePath];
    const loaded = require('../lib/fileVideoStreamer');

    return {
        FileVideoStreamer: loaded.FileVideoStreamer,
        restore() {
            childProcess.spawn = originalSpawn;
            delete require.cache[modulePath];
        }
    };
}

test('stale ffmpeg close event does not clear the active encoder process', () => {
    const tempFile = path.join(os.tmpdir(), 'ckast-streamer-race-test.mp4');
    fs.writeFileSync(tempFile, 'not real media');

    const processes = [];
    const { FileVideoStreamer, restore } = freshStreamerWithSpawn(() => {
        const proc = new FakeProcess(1000 + processes.length);
        processes.push(proc);
        return proc;
    });

    try {
        const streamer = new FileVideoStreamer();

        streamer.start(tempFile, { sendSegment() {} });
        streamer.restartAt(12, {});

        assert.equal(processes.length, 2);
        assert.equal(processes[0].killed, true);
        assert.equal(streamer.getStatus().ffmpegPid, processes[1].pid);

        processes[0].emit('close', 0);

        assert.equal(streamer.getStatus().ffmpegPid, processes[1].pid);
        assert.equal(streamer.getStatus().active, true);
    } finally {
        restore();
        fs.rmSync(tempFile, { force: true });
    }
});

test('stopped ffmpeg close event does not report a stream error', () => {
    const tempFile = path.join(os.tmpdir(), 'ckast-streamer-stop-test.mp4');
    fs.writeFileSync(tempFile, 'not real media');

    const processes = [];
    const { FileVideoStreamer, restore } = freshStreamerWithSpawn(() => {
        const proc = new FakeProcess(2000 + processes.length);
        processes.push(proc);
        return proc;
    });

    try {
        const streamer = new FileVideoStreamer();

        streamer.start(tempFile, { sendSegment() {} });
        streamer.stop();
        processes[0].emit('close', 3131621040);

        assert.equal(processes[0].killed, true);
        assert.equal(streamer.getStatus().mode, 'idle');
        assert.equal(streamer.getStatus().error, null);
        assert.equal(streamer.getStatus().active, false);
    } finally {
        restore();
        fs.rmSync(tempFile, { force: true });
    }
});

test('file input is paced in real time before FFmpeg opens it', () => {
    const tempFile = path.join(os.tmpdir(), 'ckast-streamer-pacing-test.mp4');
    fs.writeFileSync(tempFile, 'not real media');
    let ffmpegArgs = null;
    const { FileVideoStreamer, restore } = freshStreamerWithSpawn((command, args) => {
        ffmpegArgs = args;
        return new FakeProcess(3000);
    });

    try {
        const streamer = new FileVideoStreamer();
        streamer.start(tempFile, { sendSegment() {} });

        const readRateIndex = ffmpegArgs.indexOf('-re');
        const inputIndex = ffmpegArgs.indexOf('-i');
        assert.ok(readRateIndex >= 0);
        assert.ok(readRateIndex < inputIndex);
        streamer.stop();
    } finally {
        restore();
        fs.rmSync(tempFile, { force: true });
    }
});

test('subtitle setup failure leaves the file streamer in an error state', () => {
    const tempFile = path.join(os.tmpdir(), 'ckast-streamer-subtitle-error.mp4');
    const missingSubtitle = path.join(os.tmpdir(), 'ckast-missing-subtitle.srt');
    fs.writeFileSync(tempFile, 'not real media');
    fs.rmSync(missingSubtitle, { force: true });
    const { FileVideoStreamer } = require('../lib/fileVideoStreamer');
    const streamer = new FileVideoStreamer();

    try {
        assert.throws(() => streamer.start(tempFile, {
            subtitlesEnabled: true,
            externalSubtitlePath: missingSubtitle,
            subtitleDelay: 1,
            sendSegment() {}
        }), /Subtitle file not found/);

        const status = streamer.getStatus();
        assert.equal(status.active, false);
        assert.equal(status.mode, 'error');
        assert.match(status.error, /Subtitle file not found/);
    } finally {
        streamer.stop();
        fs.rmSync(tempFile, { force: true });
    }
});

test('ended file encoder remains controllable while TV playback may be buffered', () => {
    const tempFile = path.join(os.tmpdir(), 'ckast-streamer-ended-buffer.mp4');
    fs.writeFileSync(tempFile, 'not real media');
    let ffmpegProcess;
    const { FileVideoStreamer, restore } = freshStreamerWithSpawn(() => {
        ffmpegProcess = new FakeProcess(4000);
        return ffmpegProcess;
    });

    try {
        const streamer = new FileVideoStreamer();
        streamer.start(tempFile, { sendSegment() {} });
        ffmpegProcess.emit('close', 0);

        assert.equal(streamer.getStatus().active, false);
        assert.equal(streamer.getStatus().mode, 'ended');
        assert.equal(streamer.getStatus().playbackAvailable, true);

        streamer.stop();
        assert.equal(streamer.getStatus().playbackAvailable, false);
    } finally {
        restore();
        fs.rmSync(tempFile, { force: true });
    }
});

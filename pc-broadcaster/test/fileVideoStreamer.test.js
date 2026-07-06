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

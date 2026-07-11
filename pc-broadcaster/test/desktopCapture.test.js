const assert = require('assert');
const EventEmitter = require('events');
const test = require('node:test');

const { DesktopCapture } = require('../lib/desktopCapture');

class FakeProcess extends EventEmitter {
    constructor(pid) {
        super();
        this.pid = pid;
        this.killed = false;
        this.stderr = new EventEmitter();
        this.stdout = {
            pipe: (target) => {
                this.pipedTo = target;
            }
        };
    }

    kill() {
        this.killed = true;
    }
}

class FakeMp4Frag extends EventEmitter {
    removeAllListeners() {
        super.removeAllListeners();
    }
}

function createCapture(options = {}) {
    const processes = [];
    const spawnCalls = [];
    let nextPid = 100;
    const capture = new DesktopCapture({
        watchdogMs: options.watchdogMs || 20,
        ffmpegCommand: options.ffmpegCommand || 'configured-ffmpeg',
        mp4fragFactory: () => new FakeMp4Frag(),
        spawnProcess(command, args) {
            spawnCalls.push({ command, args });
            const process = new FakeProcess(nextPid++);
            processes.push(process);
            return process;
        }
    });
    return { capture, processes, spawnCalls };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('desktop capture uses the configured FFmpeg command and arms startup watchdog', () => {
    const { capture, spawnCalls } = createCapture();

    capture.start(() => {});

    assert.equal(spawnCalls[0].command, 'configured-ffmpeg');
    assert.equal(capture.getStatus().active, true);
    assert.equal(capture.getStatus().watchdogArmed, true);
    capture.stop();
});

test('desktop capture restarts when no initialization data arrives', async () => {
    const { capture, processes } = createCapture({ watchdogMs: 10 });

    capture.start(() => {});
    await delay(25);

    assert.ok(processes.length >= 2);
    assert.equal(processes[0].killed, true);
    assert.equal(capture.getStatus().active, true);
    capture.stop();
});

test('unexpected desktop FFmpeg close reports inactive until watchdog restart', async () => {
    const { capture, processes } = createCapture({ watchdogMs: 20 });

    capture.start(() => {});
    processes[0].emit('close', 1);

    assert.equal(capture.getStatus().active, false);
    await delay(30);
    assert.equal(processes.length, 2);
    assert.equal(capture.getStatus().active, true);
    capture.stop();
});

test('stale desktop FFmpeg close cannot clear replacement state', () => {
    const { capture, processes } = createCapture();

    capture.start(() => {});
    const first = processes[0];
    capture.start(() => {});
    const second = processes[1];

    first.emit('close', 0);

    assert.equal(capture.process, second);
    assert.equal(capture.getStatus().active, true);
    assert.equal(capture.getStatus().watchdogArmed, true);
    capture.stop();
});

test('stopping desktop capture cancels automatic restart', async () => {
    const { capture, processes } = createCapture({ watchdogMs: 10 });

    capture.start(() => {});
    capture.stop();
    await delay(20);

    assert.equal(processes.length, 1);
    assert.equal(capture.getStatus().active, false);
    assert.equal(capture.getStatus().watchdogArmed, false);
});

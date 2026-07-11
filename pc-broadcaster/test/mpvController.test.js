const assert = require('assert');
const EventEmitter = require('events');
const test = require('node:test');

const {
    MpvController,
    buildMpvArgs
} = require('../lib/mpvController');

class FakeProcess extends EventEmitter {
    constructor(pid) {
        super();
        this.pid = pid;
        this.stderr = new EventEmitter();
        this.killed = false;
    }

    kill() {
        this.killed = true;
    }
}

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.autoRespond = true;
        this.destroyed = false;
    }

    write(payload) {
        if (!this.autoRespond) return true;
        const request = JSON.parse(payload);
        process.nextTick(() => {
            this.emit('data', Buffer.from(JSON.stringify({
                request_id: request.request_id,
                error: 'success',
                data: null
            }) + '\n'));
        });
        return true;
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }
}

function createController(processes) {
    const sockets = [];
    let processIndex = 0;
    const controller = new MpvController({
        spawnProcess() {
            return processes[processIndex++];
        },
        connectSocket() {
            const socket = new FakeSocket();
            sockets.push(socket);
            process.nextTick(() => socket.emit('connect'));
            return socket;
        },
        pipeConnectTimeoutMs: 10,
        pipeRetryMs: 1
    });
    return { controller, sockets };
}

test('MPV launches as an audio-only process', () => {
    assert.equal(typeof buildMpvArgs, 'function');

    const args = buildMpvArgs('\\\\.\\pipe\\ckast-test');

    assert.ok(args.includes('--video=no'));
    assert.ok(!args.includes('--force-window=yes'));
});

test('MPV controller accepts process and socket boundaries', () => {
    const spawnProcess = () => {};
    const connectSocket = () => {};
    const controller = new MpvController({ spawnProcess, connectSocket });

    assert.equal(controller.spawnProcess, spawnProcess);
    assert.equal(controller.connectSocket, connectSocket);
});

test('MPV controller accepts bounded IPC connection timing', () => {
    const controller = new MpvController({
        pipeConnectTimeoutMs: 10,
        pipeRetryMs: 1
    });

    assert.equal(controller.pipeConnectTimeoutMs, 10);
    assert.equal(controller.pipeRetryMs, 1);
});

test('stale MPV exit cannot clear a replacement process', async () => {
    const previousMpvPath = process.env.MPV_PATH;
    process.env.MPV_PATH = process.execPath;
    const first = new FakeProcess(101);
    const second = new FakeProcess(102);
    const { controller } = createController([first, second]);

    try {
        await controller.startProcess();
        await controller.stop();
        await controller.startProcess();

        first.emit('exit', 0);

        assert.equal(controller.process, second);
        assert.equal(controller.getStatus().running, true);
    } finally {
        await controller.stop();
        if (previousMpvPath === undefined) delete process.env.MPV_PATH;
        else process.env.MPV_PATH = previousMpvPath;
    }
});

test('socket close rejects pending MPV commands immediately', async () => {
    const previousMpvPath = process.env.MPV_PATH;
    process.env.MPV_PATH = process.execPath;
    const { controller, sockets } = createController([new FakeProcess(201)]);

    try {
        await controller.startProcess();
        sockets[0].autoRespond = false;
        let rejection = null;
        const pending = controller.command(['get_property', 'time-pos']).catch((err) => {
            rejection = err;
        });

        sockets[0].emit('close');
        await new Promise((resolve) => setImmediate(resolve));

        assert.ok(rejection instanceof Error);
        assert.match(rejection.message, /closed|disconnected/i);
        await pending;
    } finally {
        await controller.stop();
        if (previousMpvPath === undefined) delete process.env.MPV_PATH;
        else process.env.MPV_PATH = previousMpvPath;
    }
});

test('stopping MPV clears partial IPC data', async () => {
    const controller = new MpvController();
    controller.buffer = '{"partial":';

    await controller.stop();

    assert.equal(controller.buffer, '');
});

test('IPC startup failure cleans up the spawned MPV process', async () => {
    const previousMpvPath = process.env.MPV_PATH;
    process.env.MPV_PATH = process.execPath;
    const mpvProcess = new FakeProcess(301);
    const controller = new MpvController({
        spawnProcess() {
            return mpvProcess;
        },
        connectSocket() {
            const socket = new FakeSocket();
            process.nextTick(() => socket.emit('error', new Error('pipe unavailable')));
            return socket;
        },
        pipeConnectTimeoutMs: 2,
        pipeRetryMs: 1
    });

    try {
        await assert.rejects(
            controller.startProcess(),
            /Could not connect to MPV IPC pipe/
        );
        assert.equal(mpvProcess.killed, true);
        assert.equal(controller.process, null);
        assert.equal(controller.getStatus().running, false);
    } finally {
        await controller.stop();
        if (previousMpvPath === undefined) delete process.env.MPV_PATH;
        else process.env.MPV_PATH = previousMpvPath;
    }
});

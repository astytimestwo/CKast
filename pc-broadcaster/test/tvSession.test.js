const assert = require('assert');
const test = require('node:test');

const { TvSession } = require('../lib/tvSession');

class FakeSocket {
    constructor() {
        this.readyState = 1;
        this.sent = [];
        this.closed = null;
    }

    send(payload) {
        this.sent.push(payload);
    }

    close(code, reason) {
        this.readyState = 3;
        this.closed = { code, reason };
    }
}

test('replacing the TV socket closes and invalidates the previous client', () => {
    const session = new TvSession();
    const first = new FakeSocket();
    const second = new FakeSocket();

    session.replaceSocket(first);
    session.replaceSocket(second);

    assert.deepEqual(first.closed, { code: 1000, reason: 'Superseded TV connection' });
    assert.equal(session.acceptTelemetry(first, { currentTime: 111 }), false);
    assert.equal(session.acceptTelemetry(second, { currentTime: 5 }), true);
    assert.equal(session.getStatus().telemetry.currentTime, 5);
});

test('changing TV mode clears telemetry and pending readiness', () => {
    const session = new TvSession();
    const socket = new FakeSocket();
    session.replaceSocket(socket);
    session.beginMode('file');
    session.acceptTelemetry(socket, { currentTime: 2 });
    session.armReadiness({ targetBufferSeconds: 5 });

    const generation = session.getStatus().generation;
    session.beginMode('desktop');

    const status = session.getStatus();
    assert.ok(status.generation > generation);
    assert.equal(status.mode, 'desktop');
    assert.equal(status.telemetry, null);
    assert.equal(status.pendingReadiness, null);
});

test('readiness is bound to the current TV generation', () => {
    const session = new TvSession();
    session.beginMode('file');

    const pending = session.armReadiness({ targetBufferSeconds: 5 });
    session.beginMode('file');

    assert.equal(session.isCurrentGeneration(pending.generation), false);
});

test('TV controls and segments are sent only to the current open socket', () => {
    const session = new TvSession();
    const first = new FakeSocket();
    const second = new FakeSocket();
    session.replaceSocket(first);
    session.replaceSocket(second);

    assert.equal(session.sendControl({ type: 'reset' }), true);
    assert.equal(session.sendSegment(Buffer.from([1, 2, 3])), true);
    assert.equal(first.sent.length, 0);
    assert.equal(second.sent.length, 2);

    second.readyState = 3;
    assert.equal(session.sendControl({ type: 'play' }), false);
    assert.equal(session.sendSegment(Buffer.from([4])), false);
});

test('closing a stale TV socket does not disconnect the active client', () => {
    const session = new TvSession();
    const first = new FakeSocket();
    const second = new FakeSocket();
    session.replaceSocket(first);
    session.replaceSocket(second);

    assert.equal(session.detachSocket(first), false);
    assert.equal(session.getStatus().connected, true);
    assert.equal(session.detachSocket(second), true);
    assert.equal(session.getStatus().connected, false);
});

test('socket backpressure triggers controlled reconnect instead of another media send', () => {
    const session = new TvSession({ maxBufferedBytes: 1024 });
    const socket = new FakeSocket();
    socket.bufferedAmount = 1025;
    session.replaceSocket(socket);

    assert.equal(session.sendSegment(Buffer.alloc(100), 'file'), false);
    assert.deepEqual(socket.closed, {
        code: 1013,
        reason: 'Broadcaster socket backpressure'
    });
    assert.equal(socket.sent.length, 0);
    assert.equal(session.getStatus().segmentStats.congestionEvents, 1);
});

test('TV session reports media segment throughput by stream kind', () => {
    const session = new TvSession();
    const socket = new FakeSocket();
    socket.bufferedAmount = 0;
    session.replaceSocket(socket);

    session.sendSegment(Buffer.alloc(10), 'desktop');
    session.sendSegment(Buffer.alloc(20), 'file');

    assert.deepEqual(session.getStatus().segmentStats, {
        totalCount: 2,
        totalBytes: 30,
        congestionEvents: 0,
        lastEventAt: session.getStatus().segmentStats.lastEventAt,
        desktop: { count: 1, bytes: 10 },
        file: { count: 1, bytes: 20 }
    });
    assert.ok(session.getStatus().segmentStats.lastEventAt > 0);
});

test('starting a new stream resets segment throughput counters', () => {
    const session = new TvSession();
    const socket = new FakeSocket();
    socket.bufferedAmount = 0;
    session.replaceSocket(socket);
    session.sendSegment(Buffer.alloc(10), 'desktop');

    session.resetSegmentStats();

    assert.deepEqual(session.getStatus().segmentStats, {
        totalCount: 0,
        totalBytes: 0,
        congestionEvents: 0,
        lastEventAt: 0,
        desktop: { count: 0, bytes: 0 },
        file: { count: 0, bytes: 0 }
    });
});

test('closing the TV session closes and detaches its socket', () => {
    const session = new TvSession();
    const socket = new FakeSocket();
    session.replaceSocket(socket);

    session.close();

    assert.deepEqual(socket.closed, { code: 1001, reason: 'CKast server shutting down' });
    assert.equal(session.getStatus().connected, false);
    assert.equal(session.getStatus().mode, 'idle');
});

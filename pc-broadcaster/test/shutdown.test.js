const assert = require('assert');
const test = require('node:test');

const { createShutdown } = require('../lib/shutdown');

test('server shutdown stops every owned resource exactly once', async () => {
    const calls = [];
    const shutdown = createShutdown({
        desktopCapture: { stop() { calls.push('desktop.stop'); } },
        fileVideo: { stop() { calls.push('file.stop'); } },
        player: { async stop() { calls.push('player.stop'); } },
        tvSession: {
            clearReadiness() { calls.push('readiness.clear'); },
            sendControl(payload) { calls.push('tv.' + payload.type); },
            close() { calls.push('tv.close'); }
        },
        httpServer: {
            listening: true,
            close(callback) {
                calls.push('http.close');
                callback();
            }
        }
    });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);

    assert.deepEqual(calls, [
        'readiness.clear',
        'tv.stop',
        'desktop.stop',
        'file.stop',
        'player.stop',
        'tv.close',
        'http.close'
    ]);
});

test('shutdown tolerates an HTTP server that never started listening', async () => {
    const shutdown = createShutdown({
        desktopCapture: { stop() {} },
        fileVideo: { stop() {} },
        player: { async stop() {} },
        tvSession: {
            clearReadiness() {},
            sendControl() {},
            close() {}
        },
        httpServer: {
            listening: false,
            close() { throw new Error('must not close'); }
        }
    });

    await shutdown('startup_error');
});

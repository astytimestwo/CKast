const EventEmitter = require('events');
const assert = require('assert');
const test = require('node:test');

const { createLiveTelemetry } = require('../lib/liveTelemetry');

function createConsoleSink() {
    const lines = [];
    return {
        lines,
        console: {
            log: (line) => lines.push({ level: 'log', line }),
            warn: (line) => lines.push({ level: 'warn', line }),
            error: (line) => lines.push({ level: 'error', line })
        }
    };
}

test('emits live events to subscribers and console without keeping a cache', () => {
    const sink = createConsoleSink();
    const telemetry = createLiveTelemetry({
        console: sink.console,
        clock: () => new Date('2026-01-01T00:00:00.000Z')
    });
    const events = [];
    const unsubscribe = telemetry.onEvent((event) => events.push(event));

    const emitted = telemetry.info('server_start', { port: 8080 });

    assert.equal(emitted.id, 1);
    assert.equal(emitted.type, 'server_start');
    assert.equal(emitted.level, 'info');
    assert.deepEqual(emitted.data, { port: 8080 });
    assert.equal(events.length, 1);
    assert.equal(sink.lines.length, 1);
    assert.match(sink.lines[0].line, /\[telemetry\] 2026-01-01T00:00:00.000Z INFO server_start/);
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, 'events'), false);

    unsubscribe();
    telemetry.info('server_tick');
    assert.equal(events.length, 1);
});

test('streams only live future events over server-sent events', () => {
    const sink = createConsoleSink();
    const telemetry = createLiveTelemetry({ console: sink.console });
    telemetry.info('before_client_connected');

    const req = new EventEmitter();
    const writes = [];
    const res = {
        writeHead(code, headers) {
            writes.push({ code, headers });
        },
        write(chunk) {
            writes.push(chunk);
        }
    };

    telemetry.attachSse(req, res);
    telemetry.warn('client_visible_event', { connected: true });

    const streamed = writes.filter((entry) => typeof entry === 'string').join('');
    assert.match(streamed, /: connected/);
    assert.doesNotMatch(streamed, /before_client_connected/);
    assert.match(streamed, /event: telemetry/);
    assert.match(streamed, /client_visible_event/);
    assert.equal(writes[0].code, 200);
    assert.equal(writes[0].headers['Content-Type'], 'text/event-stream');
    assert.match(writes[0].headers['Cache-Control'], /no-cache/);

    const writeCountBeforeClose = writes.length;
    req.emit('close');
    telemetry.error('after_client_disconnected');
    assert.equal(writes.length, writeCountBeforeClose);
});

const EventEmitter = require('events');

function normalizeData(data) {
    if (data === undefined || data === null) return {};
    if (data instanceof Error) {
        return {
            message: data.message,
            code: data.code,
            stack: data.stack
        };
    }
    if (typeof data !== 'object') return { value: data };

    try {
        return JSON.parse(JSON.stringify(data, (key, value) => {
            if (value instanceof Error) {
                return {
                    message: value.message,
                    code: value.code,
                    stack: value.stack
                };
            }
            if (typeof value === 'string' && value.length > 2000) {
                return value.slice(0, 2000) + '...';
            }
            return value;
        }));
    } catch (err) {
        return { unserializable: true, message: err.message };
    }
}

function writeConsole(targetConsole, level, event) {
    const data = event.data && Object.keys(event.data).length > 0
        ? ' ' + JSON.stringify(event.data)
        : '';
    const line = `[telemetry] ${event.ts} ${level.toUpperCase()} ${event.type}${data}`;

    if (level === 'error') {
        targetConsole.error(line);
    } else if (level === 'warn') {
        targetConsole.warn(line);
    } else {
        targetConsole.log(line);
    }
}

function createLiveTelemetry(options = {}) {
    const emitter = new EventEmitter();
    const targetConsole = options.console || console;
    const clock = options.clock || (() => new Date());
    let nextId = 1;

    function emit(level, type, data) {
        const event = {
            id: nextId++,
            ts: clock().toISOString(),
            level,
            type,
            data: normalizeData(data)
        };

        writeConsole(targetConsole, level, event);
        emitter.emit('event', event);
        return event;
    }

    function onEvent(listener) {
        emitter.on('event', listener);
        return () => emitter.off('event', listener);
    }

    function attachSse(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write(': connected\n\n');

        const unsubscribe = onEvent((event) => {
            res.write(`id: ${event.id}\n`);
            res.write('event: telemetry\n');
            res.write('data: ' + JSON.stringify(event) + '\n\n');
        });

        req.on('close', unsubscribe);
    }

    return {
        info: (type, data) => emit('info', type, data),
        warn: (type, data) => emit('warn', type, data),
        error: (type, data) => emit('error', type, data),
        onEvent,
        attachSse
    };
}

module.exports = {
    createLiveTelemetry
};

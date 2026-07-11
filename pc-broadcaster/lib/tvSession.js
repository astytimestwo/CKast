const VALID_MODES = new Set(['idle', 'desktop', 'file']);
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function createSegmentStats() {
    return {
        totalCount: 0,
        totalBytes: 0,
        congestionEvents: 0,
        lastEventAt: 0,
        desktop: { count: 0, bytes: 0 },
        file: { count: 0, bytes: 0 }
    };
}

class TvSession {
    constructor(options = {}) {
        this.maxBufferedBytes = options.maxBufferedBytes || DEFAULT_MAX_BUFFERED_BYTES;
        this.socket = null;
        this.mode = 'idle';
        this.generation = 0;
        this.telemetry = null;
        this.pendingReadiness = null;
        this.segmentStats = createSegmentStats();
    }

    replaceSocket(socket) {
        if (this.socket && this.socket !== socket) {
            try {
                this.socket.close(1000, 'Superseded TV connection');
            } catch (err) {
                // The old connection is already unusable; replacement still proceeds.
            }
        }
        this.socket = socket;
        this.generation += 1;
        this.telemetry = null;
        this.pendingReadiness = null;
        return this.getStatus();
    }

    detachSocket(socket) {
        if (this.socket !== socket) return false;
        this.socket = null;
        this.telemetry = null;
        this.pendingReadiness = null;
        return true;
    }

    close() {
        const socket = this.socket;
        this.socket = null;
        this.mode = 'idle';
        this.generation += 1;
        this.telemetry = null;
        this.pendingReadiness = null;
        if (socket) {
            try {
                socket.close(1001, 'CKast server shutting down');
            } catch (err) {
                // The connection is already closed.
            }
        }
    }

    beginMode(mode) {
        if (!VALID_MODES.has(mode)) {
            throw new Error('Unsupported TV mode: ' + mode);
        }
        this.mode = mode;
        this.generation += 1;
        this.telemetry = null;
        this.pendingReadiness = null;
        return this.getStatus();
    }

    acceptTelemetry(socket, payload) {
        if (socket !== this.socket) return false;
        this.telemetry = {
            ...(payload || {}),
            receivedAt: Date.now(),
            generation: this.generation
        };
        return true;
    }

    armReadiness(options = {}) {
        this.pendingReadiness = {
            ...options,
            generation: this.generation,
            requestedAt: Date.now()
        };
        return { ...this.pendingReadiness };
    }

    clearReadiness() {
        this.pendingReadiness = null;
    }

    resetSegmentStats() {
        this.segmentStats = createSegmentStats();
    }

    isCurrentGeneration(generation) {
        return generation === this.generation;
    }

    isConnected() {
        return !!(this.socket && this.socket.readyState === 1);
    }

    sendControl(payload) {
        if (!this.isConnected()) return false;
        try {
            this.socket.send(JSON.stringify(payload));
            return true;
        } catch (err) {
            return false;
        }
    }

    sendSegment(chunk, kind = 'file') {
        if (!this.isConnected()) return false;
        if (Number(this.socket.bufferedAmount) > this.maxBufferedBytes) {
            this.segmentStats.congestionEvents += 1;
            try {
                this.socket.close(1013, 'Broadcaster socket backpressure');
            } catch (err) {
                // The receiver will reconnect when its socket teardown completes.
            }
            return false;
        }
        try {
            this.socket.send(chunk);
            const bytes = chunk && Number(chunk.length || chunk.byteLength) || 0;
            const streamKind = kind === 'desktop' ? 'desktop' : 'file';
            this.segmentStats.totalCount += 1;
            this.segmentStats.totalBytes += bytes;
            this.segmentStats.lastEventAt = Date.now();
            this.segmentStats[streamKind].count += 1;
            this.segmentStats[streamKind].bytes += bytes;
            return true;
        } catch (err) {
            return false;
        }
    }

    getStatus() {
        return {
            connected: this.isConnected(),
            mode: this.mode,
            generation: this.generation,
            telemetry: this.telemetry ? { ...this.telemetry } : null,
            pendingReadiness: this.pendingReadiness ? { ...this.pendingReadiness } : null,
            segmentStats: {
                ...this.segmentStats,
                desktop: { ...this.segmentStats.desktop },
                file: { ...this.segmentStats.file }
            }
        };
    }
}

module.exports = {
    DEFAULT_MAX_BUFFERED_BYTES,
    TvSession
};

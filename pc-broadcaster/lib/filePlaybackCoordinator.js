const { isFilePlaybackReady } = require('./fileSync');

class FilePlaybackCoordinator {
    constructor(options) {
        this.player = options.player;
        this.fileVideo = options.fileVideo;
        this.tvSession = options.tvSession;
        this.getStreamOptions = options.getStreamOptions;
        this.sendSegment = options.sendSegment;
        this.sendControl = options.sendControl;
        this.resetTv = options.resetTv;
        this.resetStats = options.resetStats;
        this.onResume = options.onResume || (() => {});
        this.readinessTimeoutMs = Number(options.readinessTimeoutMs) || 30000;
        this.now = options.now || Date.now;
    }

    async restart(options = {}) {
        const startTime = Math.max(0, Number(options.startTime) || 0);
        const resume = !!options.resume;
        const targetBufferSeconds = Math.max(0.25, Number(options.targetBufferSeconds) || 5);

        await this.player.pause();
        await this.player.setSpeed(1);
        this.tvSession.beginMode('file');
        this.resetTv(options.reason || 'file_restart');
        this.resetStats();

        const streamOptions = {
            ...this.getStreamOptions(),
            startTime,
            sendSegment: this.sendSegment
        };
        if (options.filePath) {
            this.fileVideo.start(options.filePath, streamOptions);
        } else {
            this.fileVideo.restartAt(startTime, streamOptions);
        }

        if (resume) {
            this.tvSession.armReadiness({
                mode: 'file',
                targetBufferSeconds,
                reason: options.reason || 'file_restart'
            });
        } else {
            this.tvSession.clearReadiness();
        }

        return this.getStatus();
    }

    async resumeIfReady(tvState) {
        const pending = this.tvSession.pendingReadiness;
        if (!isFilePlaybackReady(tvState, pending)) return false;

        this.tvSession.clearReadiness();
        await this.player.setSpeed(1);
        this.sendControl({ type: 'play', generation: tvState.generation });
        await this.player.play();
        this.onResume();
        return true;
    }

    async stop(reason = 'file_stop') {
        this.tvSession.clearReadiness();
        if (this.tvSession.mode === 'file') {
            this.sendControl({ type: 'stop', reason });
        }
        this.fileVideo.stop();
        if (this.tvSession.mode === 'file') {
            this.tvSession.beginMode('idle');
        }
        return this.getStatus();
    }

    getStatus() {
        const pendingReadiness = this.tvSession.pendingReadiness
            ? { ...this.tvSession.pendingReadiness }
            : null;
        return {
            pendingReadiness,
            readinessTimedOut: !!(
                pendingReadiness &&
                this.now() - pendingReadiness.requestedAt > this.readinessTimeoutMs
            )
        };
    }
}

module.exports = {
    FilePlaybackCoordinator
};

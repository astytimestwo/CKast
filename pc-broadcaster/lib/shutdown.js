function closeHttpServer(httpServer) {
    if (!httpServer || !httpServer.listening) return Promise.resolve();
    return new Promise((resolve) => {
        httpServer.close(() => resolve());
    });
}

function createShutdown(options) {
    let shutdownPromise = null;

    return function shutdown(signal) {
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            const failures = [];
            const safely = async (operation) => {
                try {
                    await operation();
                } catch (err) {
                    failures.push(err);
                }
            };

            await safely(() => options.tvSession.clearReadiness());
            await safely(() => options.tvSession.sendControl({ type: 'stop', reason: signal }));
            await safely(() => options.desktopCapture.stop());
            await safely(() => options.fileVideo.stop());
            await safely(() => options.player.stop());
            await safely(() => options.tvSession.close());
            await safely(() => closeHttpServer(options.httpServer));

            if (failures.length > 0) {
                throw new AggregateError(failures, 'CKast shutdown encountered errors');
            }
        })();

        return shutdownPromise;
    };
}

module.exports = {
    createShutdown
};

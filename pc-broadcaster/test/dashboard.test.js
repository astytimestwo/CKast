const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function readDashboard() {
    return fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
}

test('dashboard prevents overlapping status requests', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /let statusRequestInFlight = false;/);
    assert.match(dashboard, /if \(statusRequestInFlight\) return;/);
    assert.match(dashboard, /statusRequestInFlight = true;/);
    assert.match(dashboard, /finally\s*\{\s*statusRequestInFlight = false;/);
});

test('desktop start and stop controls surface request failures', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /startBtn\.onclick = async \(\) => \{\s*try \{/);
    assert.match(dashboard, /stopBtn\.onclick = async \(\) => \{\s*try \{/);
    assert.match(dashboard, /setActionError\(captureStatus, e\)/);
});

test('polling cannot overwrite a latched action error', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /const latchedStatusErrors = new WeakSet\(\);/);
    assert.match(dashboard, /if \(latchedStatusErrors\.has\(el\)\) return;/);
    assert.match(dashboard, /setActionError\(captureStatus, e\);/);
});

test('dashboard surfaces a TV readiness timeout', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /sync && sync\.readinessTimedOut/);
    assert.match(dashboard, /TV did not reach the requested buffer/);
});

test('dashboard keeps buffered file playback controls available after the encoder ends', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /currentTvVideo && currentTvVideo\.playbackAvailable/);
});

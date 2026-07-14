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

test('dashboard disables known unsupported embedded subtitle tracks', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /subtitle\.burnInSupport === 'unsupported'/);
    assert.match(dashboard, /opt\.disabled = unsupported/);
    assert.match(dashboard, /unsupported for burn-in/);
    assert.match(dashboard, /subtitle\.subtitleIndex !== undefined \? subtitle\.subtitleIndex : subtitle\.index/);
    assert.match(dashboard, /Subtitle size \(1 = original\)/);
});

test('dashboard renders and switches MPV audio tracks without restarting playback', () => {
    const dashboard = readDashboard();

    assert.match(dashboard, /<select id="audioTrackSelect" disabled>/);
    assert.match(dashboard, /function renderAudioTrackChoices\(player\)/);
    assert.match(dashboard, /player\.audioTracks/);
    assert.match(dashboard, /audioTrackSelect\.onchange = async \(\) =>/);
    assert.match(dashboard, /postJson\('\/api\/player\/audio-track', \{\s*audioTrackId:/);
    assert.match(dashboard, /audioTrackSelect\.value = String\(confirmedAudioTrackId\)/);
});

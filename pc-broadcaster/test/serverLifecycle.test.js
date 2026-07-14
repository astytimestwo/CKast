const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('desktop reconnect rebases capture timing to the replacement TV pipeline', () => {
    assert.match(
        serverSource,
        /tvSession\.mode === 'desktop'[\s\S]*?S\.captureTimelineStartedAtMs = Date\.now\(\)/
    );
});

test('audio-track route changes only the MPV audio track', () => {
    assert.match(
        serverSource,
        /app\.post\('\/api\/player\/audio-track',[\s\S]*?player\.setAudioTrack\(req\.body && req\.body\.audioTrackId\)[\s\S]*?res\.json\(\{ success: true, player: status \}\)/
    );
});

test('file playback disables TV autoplay before resetting the paused pipeline', () => {
    const functionStart = serverSource.indexOf('function resetTvForFilePlayback');
    const functionEnd = serverSource.indexOf('\n}\n\nfunction clearTvTimingState', functionStart);
    const resetSource = serverSource.slice(functionStart, functionEnd);

    const fixedLatencyControl = resetSource.indexOf('sendFilePlaybackTvControls');
    const pausedReset = resetSource.indexOf("type: 'reset'");

    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    assert.ok(fixedLatencyControl >= 0 && pausedReset >= 0);
    assert.ok(
        fixedLatencyControl < pausedReset,
        'fixed-latency file controls must precede reset(autoPlay: false)'
    );
});

test('server validates subtitle options before committing or restarting playback', () => {
    assert.match(serverSource, /let currentMedia = null;/);

    const functionStart = serverSource.indexOf('function applyStreamOptions');
    const functionEnd = serverSource.indexOf('\n}\n\nfunction applyFixedLatencyOptions', functionStart);
    const applySource = serverSource.slice(functionStart, functionEnd);
    const normalize = applySource.indexOf('normalizeStreamOptions');
    const validate = applySource.indexOf('assertSubtitleBurnInSupported');
    const commit = applySource.indexOf('streamOptions = next');

    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    assert.ok(normalize >= 0 && validate > normalize && commit > validate);
});

test('server performs initial alignment seek and resets the pending flag', () => {
    assert.match(
        serverSource,
        /if\s*\(filePlayback\.initialAlignmentPending\)[\s\S]*?filePlayback\.initialAlignmentPending\s*=\s*false;[\s\S]*?player\.seek/
    );
});

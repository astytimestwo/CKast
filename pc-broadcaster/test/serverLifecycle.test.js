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

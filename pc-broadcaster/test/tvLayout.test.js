const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

function readTvIndex() {
    return fs.readFileSync(path.join(__dirname, '../../tv-app/index.html'), 'utf8');
}

test('video surface has black backing for letterbox bars', () => {
    const html = readTvIndex();
    const videoRule = html.match(/video\s*\{[^}]*\}/);

    assert.ok(videoRule, 'Expected tv-app index.html to define a video CSS rule.');
    assert.match(videoRule[0], /background(?:-color)?\s*:\s*(?:#000|black)\b/i);
});

test('TV stop command clears media pipeline without starting a new stream pipeline', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../tv-app/js/main.js'), 'utf8');

    assert.match(script, /function clearMediaPipeline\s*\(/);
    assert.match(script, /msg\.type === 'stop'[\s\S]*clearMediaPipeline\(/);
    assert.doesNotMatch(script, /msg\.type === 'stop'[\s\S]{0,160}createMediaPipeline\(/);
});

test('file playback mode does not run TV fixed-latency correction loop', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../../tv-app/js/main.js'), 'utf8');

    assert.match(server, /type:\s*'reset'[\s\S]{0,120}mode:\s*'file'/);
    assert.match(script, /var playbackMode = 'idle';/);
    assert.match(script, /playbackMode !== 'desktop'/);
});

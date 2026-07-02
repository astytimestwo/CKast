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

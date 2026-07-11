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

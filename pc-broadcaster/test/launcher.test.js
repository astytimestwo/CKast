const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const launcher = fs.readFileSync(path.join(__dirname, '../start.bat'), 'utf8');

test('launcher runs from its own directory', () => {
    assert.match(launcher, /cd \/d "%~dp0"/i);
});

test('launcher only terminates the process listening locally on port 8080', () => {
    assert.match(launcher, /Get-NetTCPConnection -LocalPort 8080 -State Listen/);
    assert.doesNotMatch(launcher, /wmic process where/i);
    assert.doesNotMatch(launcher, /findstr :8080/i);
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('repository uses the configured TV fallback and supported Node versions', () => {
    const packageJson = JSON.parse(readRepoFile('pc-broadcaster/package.json'));
    const tvScript = readRepoFile('tv-app/js/main.js');

    assert.equal(packageJson.engines.node, '>=20');
    assert.doesNotMatch(tvScript, /10\.204\.247\.239/);
    assert.match(tvScript, /var DEFAULT_SERVER_IP = '(?:\d{1,3}\.){3}\d{1,3}';/);
    assert.equal(fs.existsSync(path.join(repoRoot, 'js/main.js')), false);
});

test('GitHub CI validates Node 20 and 22 without publishing', () => {
    const workflow = readRepoFile('.github/workflows/ci.yml');

    assert.match(workflow, /node-version:\s*\[20, 22\]/);
    assert.match(workflow, /npm ci/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run check/);
    assert.doesNotMatch(workflow, /npm publish|deployment|release/i);
});

test('public security and contribution guidance is actionable', () => {
    const security = readRepoFile('SECURITY.md');
    const contributing = readRepoFile('CONTRIBUTING.md');

    assert.match(security, /trusted local network/i);
    assert.match(security, /privately/i);
    assert.match(security, /do not open a public issue/i);
    assert.match(contributing, /npm ci/);
    assert.match(contributing, /npm test/);
    assert.match(contributing, /npm run check/);
});

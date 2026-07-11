const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { summarizeProbe } = require('../lib/mediaProbe');
const { buildSubtitleFilter } = require('../lib/fileVideoStreamer');

test('summarizes subtitle streams with zero-based subtitle ordinals', () => {
    const media = summarizeProbe({
        format: { duration: '60' },
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
            { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 },
            { index: 2, codec_type: 'audio', codec_name: 'aac', channels: 6 },
            { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
            { index: 7, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'jpn' } }
        ]
    }, 'D:\\Media\\movie.mkv');

    assert.deepEqual(media.subtitles.map((subtitle) => ({
        index: subtitle.index,
        subtitleIndex: subtitle.subtitleIndex,
        language: subtitle.language
    })), [
        { index: 5, subtitleIndex: 0, language: 'eng' },
        { index: 7, subtitleIndex: 1, language: 'jpn' }
    ]);
});

test('subtitle filter sees absolute source time after a file restart', () => {
    assert.equal(typeof buildSubtitleFilter, 'function');
    const subtitlePath = path.join(os.tmpdir(), 'ckast-subtitle-timeline.srt');
    fs.writeFileSync(subtitlePath, '1\n00:00:06,000 --> 00:00:09,000\nVisible\n');

    try {
        const result = buildSubtitleFilter({
            filePath: 'C:\\Media\\movie.mkv',
            subtitlesEnabled: true,
            externalSubtitlePath: subtitlePath,
            subtitleDelay: 0,
            subtitleScale: 1
        }, 6);

        assert.match(result.filter, /^setpts=PTS\+6\/TB,subtitles=.*?,setpts=PTS-STARTPTS$/);
    } finally {
        fs.rmSync(subtitlePath, { force: true });
    }
});

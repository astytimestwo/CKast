const assert = require('assert');
const test = require('node:test');

const { summarizeProbe } = require('../lib/mediaProbe');

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


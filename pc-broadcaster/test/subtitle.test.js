const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    assertSubtitleBurnInSupported,
    summarizeProbe
} = require('../lib/mediaProbe');
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

test('classifies text, image, and unknown subtitle codecs for burn-in', () => {
    const media = summarizeProbe({
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264' },
            { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
            { index: 4, codec_type: 'subtitle', codec_name: 'ass' },
            { index: 5, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
            { index: 6, codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
            { index: 7, codec_type: 'subtitle', codec_name: 'mystery_subtitle' }
        ]
    }, 'D:\\Media\\movie.mkv');

    assert.deepEqual(media.subtitles.map((subtitle) => ({
        subtitleIndex: subtitle.subtitleIndex,
        burnInSupport: subtitle.burnInSupport
    })), [
        { subtitleIndex: 0, burnInSupport: 'supported' },
        { subtitleIndex: 1, burnInSupport: 'supported' },
        { subtitleIndex: 2, burnInSupport: 'unsupported' },
        { subtitleIndex: 3, burnInSupport: 'unsupported' },
        { subtitleIndex: 4, burnInSupport: 'unknown' }
    ]);
});

test('rejects only known unsupported embedded subtitle tracks', () => {
    const media = summarizeProbe({
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264' },
            { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
            { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
            { index: 5, codec_type: 'subtitle', codec_name: 'mystery_subtitle' }
        ]
    }, 'D:\\Media\\movie.mkv');

    assert.doesNotThrow(() => assertSubtitleBurnInSupported(media, {
        subtitlesEnabled: true,
        subtitleStreamIndex: 0,
        externalSubtitlePath: ''
    }));
    assert.throws(() => assertSubtitleBurnInSupported(media, {
        subtitlesEnabled: true,
        subtitleStreamIndex: 1,
        externalSubtitlePath: ''
    }), /hdmv_pgs_subtitle.*cannot be burned into the TV video/);
    assert.doesNotThrow(() => assertSubtitleBurnInSupported(media, {
        subtitlesEnabled: true,
        subtitleStreamIndex: 2,
        externalSubtitlePath: ''
    }));
    assert.doesNotThrow(() => assertSubtitleBurnInSupported(media, {
        subtitlesEnabled: true,
        subtitleStreamIndex: 1,
        externalSubtitlePath: 'D:\\Media\\movie.srt'
    }));
});

test('default subtitle scale preserves native styling', () => {
    const subtitlePath = path.join(os.tmpdir(), 'ckast-subtitle-native-style.srt');
    fs.writeFileSync(subtitlePath, '1\n00:00:01,000 --> 00:00:02,000\nNormal\n');

    try {
        const result = buildSubtitleFilter({
            filePath: 'C:\\Media\\movie.mkv',
            subtitlesEnabled: true,
            externalSubtitlePath: subtitlePath,
            subtitleScale: 1
        });

        assert.doesNotMatch(result.filter, /force_style/);
        assert.doesNotMatch(result.filter, /Fontsize=42/i);
    } finally {
        fs.rmSync(subtitlePath, { force: true });
    }
});

test('non-default subtitle scale uses a moderate default-size override', () => {
    const subtitlePath = path.join(os.tmpdir(), 'ckast-subtitle-relative-scale.srt');
    fs.writeFileSync(subtitlePath, '1\n00:00:01,000 --> 00:00:02,000\nScaled\n');

    try {
        const result = buildSubtitleFilter({
            filePath: 'C:\\Media\\movie.mkv',
            subtitlesEnabled: true,
            externalSubtitlePath: subtitlePath,
            subtitleScale: 1.5
        });

        assert.match(result.filter, /force_style='FontSize=24'/);
        assert.doesNotMatch(result.filter, /FontSize=63/i);
    } finally {
        fs.rmSync(subtitlePath, { force: true });
    }
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

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function resolveFfprobePath() {
    if (process.env.FFPROBE_PATH) {
        return process.env.FFPROBE_PATH;
    }

    if (process.env.FFMPEG_PATH) {
        const sibling = path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe.exe');
        if (fs.existsSync(sibling)) return sibling;
    }

    return 'ffprobe';
}

function probeMedia(filePath) {
    const normalizedPath = path.resolve(filePath || '');
    if (!fs.existsSync(normalizedPath)) {
        return Promise.reject(new Error('Media file not found: ' + normalizedPath));
    }

    const ffprobePath = resolveFfprobePath();
    const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        normalizedPath
    ];

    return new Promise((resolve, reject) => {
        const proc = spawn(ffprobePath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.once('error', (err) => {
            reject(new Error('Could not start ffprobe: ' + err.message));
        });

        proc.once('close', (code) => {
            if (code !== 0) {
                reject(new Error('ffprobe failed: ' + (stderr.trim() || 'exit code ' + code)));
                return;
            }

            try {
                const raw = JSON.parse(stdout);
                resolve(summarizeProbe(raw, normalizedPath));
            } catch (err) {
                reject(new Error('Could not parse ffprobe output: ' + err.message));
            }
        });
    });
}

function summarizeProbe(raw, filePath) {
    const streams = Array.isArray(raw.streams) ? raw.streams : [];
    const format = raw.format || {};

    return {
        filePath,
        fileName: path.basename(filePath),
        duration: Number(format.duration) || 0,
        size: Number(format.size) || 0,
        bitrate: Number(format.bit_rate) || 0,
        formatName: format.format_name || '',
        video: streams
            .filter((stream) => stream.codec_type === 'video')
            .map((stream) => ({
                index: stream.index,
                codec: stream.codec_name || '',
                width: stream.width || 0,
                height: stream.height || 0,
                fps: stream.avg_frame_rate || stream.r_frame_rate || ''
            })),
        audio: streams
            .filter((stream) => stream.codec_type === 'audio')
            .map((stream) => ({
                index: stream.index,
                codec: stream.codec_name || '',
                channels: stream.channels || 0,
                language: stream.tags && stream.tags.language ? stream.tags.language : ''
            })),
        subtitles: streams
            .filter((stream) => stream.codec_type === 'subtitle')
            .map((stream, subtitleIndex) => ({
                index: stream.index,
                subtitleIndex,
                codec: stream.codec_name || '',
                language: stream.tags && stream.tags.language ? stream.tags.language : '',
                title: stream.tags && stream.tags.title ? stream.tags.title : ''
            }))
    };
}

module.exports = {
    probeMedia,
    resolveFfprobePath,
    summarizeProbe
};

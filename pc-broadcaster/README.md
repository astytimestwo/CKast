# CKast: PC Broadcaster

This is the backend server that performs the heavy lifting for the CKast system. It leverages Node.js, `ws` (WebSockets), native `FFmpeg`, and optional `MPV` for synced local-file playback.

## Prerequisites
1. **Node.js** (v20.0 or higher).
2. **FFmpeg**: Must be installed and registered in your Windows Environment Variables or PATH.
   - Easiest installation via Windows terminal: `winget install Gyan.FFmpeg`
   - Verify by typing `ffmpeg -version` in your terminal.
3. **MPV** for synced local-file playback with PC audio.
   - MPV is not bundled with CKast. Download a Windows MPV build separately.
   - CKast auto-detects `../mpv-v0.41.0-x86_64-pc-windows-msvc/mpv.exe` when that local folder exists.
   - You can also set `MPV_PATH=C:\path\to\mpv.exe`.
   - Or place MPV at `pc-broadcaster/vendor/mpv/mpv.exe`.

## Installation
Navigate into this `pc-broadcaster` directory and install the necessary Node packages:

```bash
npm install
```

## Running the Server
You have two options to bring your PC broadcast network online:

### Option A: The Automated Script (Recommended)
Simply double click the `start.bat` file located inside this folder.
This script acts as a smart launcher:
1. It runs from the folder that contains the script.
2. It queries Windows for the single process, if any, listening locally on port 8080 and stops only that PID.
3. It starts a fresh CKast server without terminating unrelated Node processes.

### Option B: Manual Terminal
1. Start the server manually via terminal to see debug outputs:
   ```bash
   node server.js
   ```
2. Open your PC web browser and navigate to the dashboard at:
   `http://localhost:8080`
3. Click **Start Cast** to begin the heavy-lifting FFmpeg capture process. Your TV will instantly transition from its standby screen to the live feed.

## Synced Local Player Mode
This mode keeps audio on the PC and sends video-only to the TV.

1. Start the server and open `http://localhost:8080`.
2. Enter a local media file path and click **Open**.
3. Open the CKast TV app and wait for it to connect.
4. Choose quality, TV fit, optional subtitle settings, and prebuffer delay.
5. Click **Synced Play**.

The PC plays audio through MPV. The TV receives video-only FFmpeg fMP4 chunks and sends a lightweight sync-state ping once per second so the PC can keep audio aligned.

For files with multiple audio tracks, use **Audio track** in the Local Player panel. MPV
switches the PC audio immediately without seeking, pausing, or restarting the TV video stream.

File FFmpeg input is paced in real time. For synchronized play and every restart, CKast
pauses MPV, resets the TV pipeline, and waits for receiver telemetry to prove that the
requested buffer is ready before resuming. A 30-second readiness timeout is shown in the
dashboard and does not force playback. MPV keeps its playback window visible so Windows and
MPV playback controls remain available while the TV receives the separately encoded stream.

Subtitle notes:
- CKast uses FFmpeg burn-in: subtitle pixels become part of the TV video. The TV does not receive a separate subtitle track, so changing or disabling subtitles requires a video-stream restart.
- Subtitle size `1` preserves the track's original/default styling. Other values apply a moderate explicit font-size override during burn-in.
- Embedded text subtitle tracks and external subtitle files are supported. Known image-based tracks such as PGS, DVD, and DVB subtitles are shown but disabled because the text burn-in filter cannot render them.
- External `.srt` files support delay by creating a temporary shifted subtitle file in `pc-broadcaster/.runtime/`.
- Changing subtitle or quality settings restarts the TV video stream at the current playback position.

## Tweaking Quality & Performance
If you encounter network limits (e.g. slow router causing buffer delays), you can easily modify the FFmpeg encode arguments inside `server.js`:
If you think the latency is bad, it is. Cause it is optimised for highest quality. 

- **Bitrate**: `'-b:v', '20000k'` controls the visual sharpness and buffering speed. Drop this back to `10000k` or `8000k` if your local Wi-Fi router gets overwhelmed during explosive scenes, which can induce stutter.
- **Latency / Buffering**: `'-rtbufsize', '1024M'` prevents the desktop capturer from dropping frames if your CPU spikes.
- **Hardware Encoders**: If you have an NVIDIA GPU, you can drastically reduce CPU load by changing `'-c:v', 'libx264'` to `'-c:v', 'h264_nvenc'`. Keep in mind `libx264` ensures maximum compatibility out of the box.

## Security Note
This server binds to `0.0.0.0` and accepts websocket connections from any device on your local network. It is entirely unencrypted. **Do not run this server on public or untrusted Wi-Fi networks.**

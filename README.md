# CKast

CKast is an ultra-low latency, local Wi-Fi screen mirroring solution designed specifically for Samsung Tizen TVs (Tizen 4.0 & above). It bypasses the traditional WebRTC limitation of older Smart TVs by utilizing direct native hardware-decoding (H.264 fMP4) streamed over websockets.

## Architecture

This project splits into two components:
1. **The TV App (Tizen Web App)**: A lightweight HTML5 video player that leverages Media Source Extensions (MSE) to decode and render raw fragmented MP4 chunks directly using the TV's built-in H.264 hardware decoder.
2. **The PC Broadcaster**: A Node.js relay server that spawns native `FFmpeg` to capture the Windows desktop in real-time (`gdigrab`), process an H.264 encode without buffering (`-tune zerolatency`), and pipes the binary stream to the TV.
3. **The Synced Local Player**: A PC-side MPV/FFmpeg mode where MPV plays audio locally on the PC while CKast streams video-only to the TV with lightweight sync correction.

## Why CKast?
- **Silky Smooth**: Most browser-based screen captures (`MediaRecorder`) produce VP8/WebM which forces older TVs into software-decoding (resulting in stutter). CKast forces H.264, triggering the TV's native hardware decoder.
- **Micro-Latency**: Direct WebSocket piping without intermediate transcoding clusters.
- **Fresh State Persistence**: Automatic cache wiping and `mp4frag` header detection guarantees the TV decoder never freezes on reconnects or out-of-order chunks.

## Project Structure
- `tv-app/` - **The Tizen App** files. Open this folder in VS Code with the Samsung Tizen TV extension and build/deploy from there.
- `pc-broadcaster/` - **The Node Server**. Run this on the Windows machine you wish to broadcast from.

## External Requirements
- **Node.js 16+** for the PC broadcaster.
- **FFmpeg / FFprobe** available on PATH for capture, file probing, and video streaming.
- **MPV** for synced local-player mode. MPV is intentionally not included in this repo; download a Windows MPV build yourself, then either:
  - set `MPV_PATH=C:\path\to\mpv.exe`
  - place it at `pc-broadcaster/vendor/mpv/mpv.exe`
  - or keep a local ignored folder like `mpv-v0.41.0-x86_64-pc-windows-msvc/` next to `pc-broadcaster/`

## Setup Instructions

### 1. The TV Target
1. Open `tv-app/` in VS Code with the Samsung Tizen TV extension.
2. In `tv-app/js/main.js`, update `var SERVER_IP = 'YOUR_PC_IP_HERE';` to your PC's local WiFi IP (e.g., `192.168.1.5`).
3. Use **Tizen TV: Build Signed Package**, then **Tizen TV: Launch Application** to install/run it on your TV.

### 2. The PC Broadcaster
Please refer to the `README.md` inside the `pc-broadcaster/` directory for full Windows setup instructions.

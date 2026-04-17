# CKast: PC Broadcaster

This is the backend server that performs the heavy lifting for the CKast system. It leverages Node.js, `ws` (WebSockets), and native `FFmpeg` to capture your Windows desktop and stream it seamlessly to your Tizen TV.

## Prerequisites
1. **Node.js** (v16.0 or higher recommended).
2. **FFmpeg**: Must be installed and registered in your Windows Environment Variables or PATH.
   - Easiest installation via Windows terminal: `winget install Gyan.FFmpeg`
   - Verify by typing `ffmpeg -version` in your terminal.

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
1. It automatically hunts down any previous "zombie" or frozen server instances that failed to release the TV connection port (8080).
2. It safely clears the environment.
3. It boots up the fresh stream server perfectly.

### Option B: Manual Terminal
1. Start the server manually via terminal to see debug outputs:
   ```bash
   node server.js
   ```
2. Open your PC web browser and navigate to the dashboard at:
   `http://localhost:8080`
3. Click **Start Cast** to begin the heavy-lifting FFmpeg capture process. Your TV will instantly transition from its standby screen to the live feed.

## Tweaking Quality & Performance
If you encounter network limits (e.g. slow router causing buffer delays), you can easily modify the FFmpeg encode arguments inside `server.js`:

- **Bitrate**: `'-b:v', '20000k'` controls the visual sharpness and buffering speed. Drop this back to `10000k` or `8000k` if your local Wi-Fi router gets overwhelmed during explosive scenes, which can induce stutter.
- **Latency / Buffering**: `'-rtbufsize', '1024M'` prevents the desktop capturer from dropping frames if your CPU spikes.
- **Hardware Encoders**: If you have an NVIDIA GPU, you can drastically reduce CPU load by changing `'-c:v', 'libx264'` to `'-c:v', 'h264_nvenc'`. Keep in mind `libx264` ensures maximum compatibility out of the box.

## Security Note
This server binds to `0.0.0.0` and accepts websocket connections from any device on your local network. It is entirely unencrypted. **Do not run this server on public or untrusted Wi-Fi networks.**

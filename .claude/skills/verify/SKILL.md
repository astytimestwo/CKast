---
name: verify
description: Drive CKast broadcaster changes through the dashboard, API, MPV, FFmpeg, and a disposable TV WebSocket client.
---

# CKast runtime verification

1. Ensure `pc-broadcaster` dependencies are installed and set `MPV_PATH` to a working Windows `mpv.exe` when it is not on PATH.
2. Start `npm --prefix pc-broadcaster start` on port 8080 and open the dashboard.
3. Create small media fixtures under ignored `pc-broadcaster/.runtime/` with FFmpeg.
4. Drive the user flow through the dashboard: Open media, choose subtitle options, and use Synced Play.
5. For TV-dependent paths, connect a disposable `ws` client to `ws://127.0.0.1:8080/tv`; inspect control messages and accept binary segments.
6. Verify failures at the dashboard surface by using an existing invalid subtitle source, then retry valid settings to confirm recovery.
7. Stop the server and remove generated `.runtime` fixtures.

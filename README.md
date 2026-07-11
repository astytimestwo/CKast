# CKast

CKast is a local Wi-Fi casting setup for Samsung Tizen TVs. The TV app receives video-only H.264 fragmented MP4 over WebSocket and plays it through the TV hardware decoder. The PC app can either capture the desktop or run the synced local-player mode where MPV plays audio on the PC while CKast streams only the video to the TV.

## Project Layout

- `tv-app/` - Samsung Tizen TV web app. Open this folder in VS Code when building the TV package.
- `pc-broadcaster/` - Node.js server, dashboard, FFmpeg stream relay, and MPV controller.
- `stable/` - local reference builds only. Ignored by Git.
- `mpv-v*/`, `mpv-master/` - local MPV/source folders only. Ignored by Git.

## Requirements

- Windows PC and Samsung Tizen TV on the same local network.
- VS Code.
- Samsung **Tizen TV** VS Code extension: `tizensdk.tizentv`.
- Node.js 16+.
- FFmpeg and FFprobe available on PATH.
- MPV for synced local-player mode. MPV is intentionally not included in this repo.

MPV options:

```powershell
$env:MPV_PATH = "C:\path\to\mpv.exe"
```

Or place MPV at either:

```text
pc-broadcaster/vendor/mpv/mpv.exe
mpv-v0.41.0-x86_64-pc-windows-msvc/mpv.exe
```

## TV Setup

### 1. Install The VS Code Extension

Install the Samsung Tizen TV extension from VS Code Extensions, or run:

```powershell
code --install-extension tizensdk.tizentv
```

Open the command palette with `Ctrl+Shift+P` and type `Tizen TV` to see the extension commands.

### 2. Open The TV App Folder

In VS Code, open this folder directly:

```text
tv-app/
```

The extension expects the Tizen project root to contain `config.xml`, so do not build from the repository root.

### 3. Know Your PC IP

Find your PC IPv4 address on the same Wi-Fi/LAN as the TV:

```powershell
ipconfig
```

You do not need to rebuild the TV app when this address changes. The TV receiver has a **PC address** field on its standby screen. Enter the PC IPv4 address there and press **Connect**; the TV saves it for the next launch.

### 4. Enable Developer Mode On The TV

On the TV:

1. Connect the TV to the same network as the PC.
2. Open **Apps**.
3. Enter `12345` using the remote or on-screen number pad.
4. Turn **Developer Mode** on.
5. Enter the PC IPv4 address as **Host PC IP**.
6. Reboot the TV.

After reboot, the Apps screen should show Developer Mode enabled.

### 5. Add Or Select The TV Target In VS Code

In VS Code command palette:

```text
Tizen TV: Set Target Device Address
```

Enter the TV IP address.

If your extension UI shows a device list/add-device command, use it to add the same TV IP and select that target. The important distinction is:

- TV Developer Mode Host PC IP = your PC IP.
- VS Code target/device address = your TV IP.

### 6. Create Or Select A Certificate Profile

Tizen packages must be signed before they install on a real TV.

Run:

```text
Tizen TV: Run Certificate Manager
```

Create or select an author/distributor certificate profile. If build fails with no active profile, reopen Certificate Manager and set the profile active.

### 7. Build The Signed Package

Run:

```text
Tizen TV: Build Signed Package
```

The extension writes the `.wgt` package into the `tv-app/` workspace root. `.wgt` files are ignored by Git.

### 8. Launch On The TV

Run:

```text
Tizen TV: Launch Application
```

The TV app should open to the CKast standby screen, then connect to the PC server once the server is running.
If the PC IP changed, edit the **PC address** field on the TV and press **Connect**.

## PC Broadcaster Setup

Install dependencies:

```powershell
cd pc-broadcaster
npm install
```

Start the server:

```powershell
npm start
```

Open the dashboard:

```text
http://localhost:8080
```

For synced local-player mode:

1. Start the server.
2. Open the TV app.
3. In the dashboard, enter a local media path.
4. Click **Open**.
5. Choose quality, fit, and subtitle options.
6. Click **Synced Play**.

## Common Fixes

- **TV app does not connect:** confirm PC and TV are on the same network, enter the PC IPv4 address in the TV app's **PC address** field, and keep the TV Developer Mode Host PC IP set to the PC IP.
- **VS Code cannot launch:** confirm the VS Code target/device address is the TV IP, not the PC IP.
- **Build signed package fails:** check Certificate Manager and set an active certificate profile.
- **App installs but old behavior remains:** uninstall/relaunch from VS Code, then rebuild and launch the signed package again.
- **MPV missing:** download MPV separately and set `MPV_PATH`, or place it in one of the supported local paths above.

## Git Notes

Do not commit local binaries or generated packages. The repo ignores:

- MPV folders
- `stable/`
- `.wgt` packages
- logs
- runtime subtitle temp files

## Sources

- Samsung TizenTV VS Code extension: https://github.com/Samsung/vscode-extension-tizentv
- Samsung TV device developer-mode flow: https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html

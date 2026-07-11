# Contributing to CKast

Thanks for helping improve CKast. Keep changes focused, preserve the local-network trust model,
and include regression coverage for behavior changes.

## Development setup

Install Node.js 20 or 22, FFmpeg/FFprobe, and MPV if you are testing synchronized local-file
playback. Then install the exact broadcaster dependencies:

```powershell
cd pc-broadcaster
npm ci
```

Samsung TV changes require the Samsung Tizen TV extension and a configured development TV.
See the root `README.md` and `tv-app/README.md` for device setup.

## Before submitting a change

From `pc-broadcaster`, run:

```powershell
npm test
npm run check
```

Add or update tests for bug fixes and behavioral changes. Do not commit generated `.wgt`
packages, `node_modules`, runtime subtitle files, logs, local MPV builds, credentials, or media
fixtures that are not intentionally licensed for the repository.

## Branches and pull requests

- Create a focused branch for each independent change.
- Explain the problem, the chosen solution, and how it was verified.
- Keep unrelated formatting or refactoring out of the pull request.
- Call out changes that affect TV installation, network behavior, FFmpeg/MPV requirements, or
  backward compatibility.
- Ensure GitHub Actions passes on Node.js 20 and 22 before requesting review.

Security vulnerabilities should follow `SECURITY.md`, not the public issue tracker.

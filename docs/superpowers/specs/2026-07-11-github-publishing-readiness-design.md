# GitHub Publishing Readiness Design

## Goal

Prepare CKast for a clean public GitHub update without pushing, deploying, or publishing
anything. The local repository should contain no personal network defaults or unused tracked
artifacts, and GitHub should automatically verify supported Node.js versions after a future
push.

## Repository cleanup

- Replace the TV app's personal LAN fallback address with the neutral documentation address
  `192.168.1.10`. Users can still enter and persist their real PC address on the TV.
- Remove the unused, zero-byte root file `js/main.js`.
- Keep generated packages, dependencies, runtime data, local binaries, and environment files
  ignored through the existing `.gitignore` rules.

## Supported runtime and CI

- Raise the supported Node.js minimum from 16 to 20 in package metadata and documentation.
- Add one GitHub Actions workflow triggered by pushes and pull requests.
- Test Node.js 20 and 22 independently.
- For each version, run `npm ci`, `npm test`, and `npm run check` from `pc-broadcaster`.
- CI performs validation only; it does not deploy, publish packages, create releases, or modify
  repository contents.

## Public collaboration documents

- Add `SECURITY.md` explaining that CKast is intended for trusted local networks and asking
  reporters not to disclose vulnerabilities publicly before maintainers respond. Direct
  reporters to GitHub's private vulnerability-reporting interface when enabled, with a
  private maintainer contact fallback through the repository owner profile.
- Add `CONTRIBUTING.md` with prerequisites, local setup, test commands, branch guidance, and
  pull-request expectations.

## Verification

- Run the complete test suite and syntax check on Node.js available locally.
- Run `npm audit --omit=dev`.
- Re-scan tracked files for private-key/token markers, personal IP defaults, large binaries,
  generated packages, and environment files.
- Confirm the working tree contains only the intended publishing-readiness changes before
  creating one local commit on `main`.

## Non-goals

- No GitHub push, pull request, deployment, release, package publication, issue templates,
  Dependabot configuration, or changelog automation.

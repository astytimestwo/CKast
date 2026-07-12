# Audio Track Selection Design

## Goal

Allow a user to switch the local player's PC audio between available media tracks, such as
French and English, without restarting playback or disturbing TV video synchronization.

## Source of truth

MPV's live `track-list` property is authoritative because MPV track IDs do not reliably match
FFprobe stream indexes. After loading media, the MPV controller reads `track-list`, keeps only
audio entries, and exposes normalized track metadata plus the selected track ID in player
status.

Each normalized audio track contains:

- MPV track `id` used by the `aid` property.
- Language, title, codec, channel count, and whether MPV selected it.
- A display label assembled by the dashboard from the available metadata.

FFprobe remains responsible for general media metadata and subtitle discovery; it is not used
to choose an MPV audio ID.

## Selection flow

The dashboard displays an audio-track selector after a file is opened. Choosing a track sends
its MPV ID to a dedicated player API. The server validates the requested ID through the MPV
controller and sets MPV's `aid` property.

The operation does not seek, pause, restart MPV, restart FFmpeg, reset the TV pipeline, or
change file-sync state. MPV switches the decoded PC audio in place while the current playback
position and TV video continue normally.

## State and errors

Player status includes `audioTracks` and `selectedAudioTrackId`. Opening or stopping media
clears stale track state. Property refresh reads both `track-list` and `aid` so the dashboard
reflects changes made through MPV as well as changes requested through CKast.

If MPV rejects an ID, the API returns an error. The dashboard restores the last confirmed
selection and shows the error through the existing latched player-status mechanism.

## UI

Add an **Audio track** selector to the Local Player panel near the existing volume controls.
It is disabled when no media is loaded or no selectable audio tracks exist. Labels prefer
language and title, then include codec/channels when present, with a stable `Track <id>`
fallback.

## Verification

- Media normalization tests cover language/title/codec/channel metadata and selected state.
- MPV controller tests prove selection sends only `set_property aid <id>` and preserves time,
  pause, speed, and audio-delay state.
- Server/dashboard contract tests cover the endpoint, selector rendering, error recovery, and
  status refresh.
- The complete regression suite and JavaScript syntax checks must pass.

## Non-goals

- TV-side audio playback.
- Remembering a preferred language across different files.
- Re-encoding or streaming audio to the TV.
- Selecting external audio files.

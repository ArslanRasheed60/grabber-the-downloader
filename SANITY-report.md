# Final Grabber 1.0.0 sanity check — 12 October 2026

The app-control and local-media sanity check passed on Windows x64. This was a
hidden Electron integration test using the real renderer, sandboxed preload,
main-process IPC, settings store and download queue.

## Checks passed

- Startup/system check, empty state, invalid/empty link feedback.
- Add, Enter and paste auto-add; multiple pasted links and partial failures.
- All seven quality/audio-only chips and their queue options.
- Whole-playlist toggle, small-playlist auto-add, large-playlist confirmation,
  Dismiss, Add all, playlist folder/numbering and empty-playlist feedback.
- Every settings field/checkbox, normalization and invalid-value feedback.
- Settings button, Close, outside click and Escape.
- Folder Change, cookie Browse/manual path/Clear and canceled dialogs.
- Open downloads folder, Show in folder, source-link opening and OS error feedback.
- Row/global Pause and Resume, log show/hide and live updates, Clear finished, Remove.
- Repair tools and update button loading/success/error states.
- Missing-tool startup, install failure, Continue anyway and successful retry.
- Unwritable download location and Choose a folder recovery.
- Real MP4, MKV, WebM and original-container outputs.
- Real MP3, M4A, Opus, FLAC, WAV and original-audio outputs.
- Real metadata, cover, chapter and subtitle embedding using controlled fixtures.
- Sponsor-segment removal using supplied fixture segments.

The final suite passed all 26 grouped checks. The separate regression suite passed
18 recovery tests, 95 existing checks and the renderer/preload/IPC integration test.

## Fixes found in the final check

- Multiline pastes now preserve URL separators instead of joining links together.
- Container choices now apply to streams that already contain both video and audio.
- WebM prefers compatible formats and converts incompatible source codecs as needed.
- WAV/WebM skip unsupported embedded cover art instead of failing the download.
- The row Pause button is enabled during Preparing, which the queue now handles safely.

## Evidence and limits

Final results: `release/sanity-1791826338355/results.json`.
Final regression log: `release/diagnostics/final-v1-unit.log`.

Native file-dialog selections and external application launches were intercepted:
the buttons and real IPC handoffs were verified, but Explorer/browser/player windows
and the Windows installer wizard were not manually operated. Missing-tool and update
button success/failure states used controlled responses; the real update/download flow
had passed earlier QA. SponsorBlock API availability was not exercised by the fixture
cut test. macOS/Linux execution and signed-in browser-cookie access were not tested.

Earlier live QA completed downloads from YouTube, Dailymotion, TikTok, X/Twitter,
Reddit and SoundCloud. A final additional YouTube smoke request encountered the
host's sign-in/bot confirmation requirement. This remains a real site restriction,
so the release does not guarantee every video or future website change will work.
The Vimeo sample's streams were reported as DRM protected during prior QA.

Run `npm run test:sanity` to repeat this check. Media/logs are saved under
`release/sanity-*`, using an isolated temporary profile.

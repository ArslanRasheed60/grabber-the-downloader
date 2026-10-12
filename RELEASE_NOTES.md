# Grabber 1.0.0

Windows x64 desktop video downloader. Download `Grabber-1.0.0-win-x64.exe` below
and run the installer.

- Bundled download engine and media tools, with Electron's built-in JavaScript runtime.
- Reliable tool-update selection, bounded YouTube requests and one-time media-link recovery.
- Browser-cookie access recovery for public videos; exported cookie files remain authoritative.
- Paste one or multiple links, choose quality or audio-only output, and queue playlists.
- Pause/resume, logs, folder actions, and clear/remove controls.
- MP4/MKV/WebM output and MP3/M4A/Opus/FLAC/WAV audio conversion.
- Optional metadata, cover art, chapters, subtitles and sponsor-segment removal.

Final sanity checks passed for every app control, all container/audio choices and
fixture postprocessing. The regression/UI suites passed. Earlier live QA completed
downloads from YouTube, Dailymotion, TikTok, X/Twitter, Reddit and SoundCloud.

Host restrictions still apply: a final YouTube recheck requested sign-in/bot
confirmation, and the tested Vimeo sample's streams were DRM protected.
Authenticated videos and macOS/Linux execution were not validated for this build.
See `SANITY-report.md` and `QA-report.md` in the source for test scope and details.

# Grabber

A desktop video and audio downloader for macOS and Windows, built with Electron
and [yt-dlp](https://github.com/yt-dlp/yt-dlp). Paste a link, choose a quality, and
save it to your download folder.

## Download

Get installers from [GitHub Releases](https://github.com/ArslanRasheed60/grabber-the-downloader/releases).

| Platform | Installer |
| --- | --- |
| macOS Apple Silicon (M1 and newer) | `Grabber-1.0.0-mac-arm64.dmg` |
| macOS Intel | `Grabber-1.0.0-mac-x64.dmg` |
| Windows x64 | `Grabber-1.0.0-win-x64.exe` |

macOS releases also include ZIP archives. Open the DMG and drag Grabber into
Applications. The builds are signed ad hoc, without Apple Developer ID signing
or notarization. On first launch, macOS may require you to allow Grabber in
**System Settings → Privacy & Security**, then open it again.

If macOS reports that the downloaded app is damaged, and you have verified that
it came from this repository's release, clear its download quarantine:

```bash
xattr -cr /Applications/Grabber.app
```

The macOS installer includes the application and its JavaScript runtime. On first
launch, Grabber checks your download folder and tools. Choose **Install missing
tools** to download yt-dlp, FFmpeg and FFprobe directly from their upstream
providers. An internet connection is required for this initial setup. The macOS
installer does not bundle these third-party executables.

## Features

- Download from sites supported by yt-dlp, including YouTube, Vimeo and SoundCloud.
- Paste multiple links and queue playlists or channels.
- Choose video quality and MP4, MKV, WebM or the original container.
- Extract audio as MP3, M4A, Opus, FLAC or WAV, or keep the original audio.
- Pause, resume and cancel downloads; view progress and individual logs.
- Add metadata, cover art, chapters and subtitles, or remove SponsorBlock segments.
- Use browser cookies or an exported cookies file for videos that require sign-in.
- Configure the download folder, concurrency, speed limit and proxy in Settings.
- Update yt-dlp from Settings when a site's download behavior changes.

Site restrictions, unavailable formats and DRM can prevent a download. Use Grabber
only for media you have permission to download.

## Run from source

Install Node.js **22.12 or newer** and npm, then:

```bash
git clone https://github.com/ArslanRasheed60/grabber-the-downloader.git
cd grabber-the-downloader
npm ci
npm start
```

If Electron's executable was not installed during `npm ci`, run
`npx install-electron --no` once. Grabber's startup check offers to install any
missing download tools. Packaged users do not need to install Node.js or Python.

## Build

Build macOS installers on a Mac:

```bash
npm ci
npm run dist:mac        # Apple Silicon: DMG and ZIP
npm run dist:mac-intel  # Intel: DMG and ZIP
```

Installers are written to `release/`. The macOS build scripts deliberately omit
download-tool binaries; the app installs them at first launch. This also keeps
locally fetched test tools out of distributed macOS installers.

Without a Developer ID certificate, `scripts/adhoc-sign.js` signs the app locally.
For certificate signing, replace the ad-hoc `build.mac.identity` setting and
configure electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`, or `CSC_NAME`.
Notarization requires additional Apple
credentials and configuration.

The Windows build includes fetched download tools:

```bash
npm run dist:win
```

Use a separate checkout or clean `resources/bin/` before fetching tools for a
different platform. Review the fetched binaries' licenses before distributing
a build that bundles them. `npm run fetch:bin` downloads tools for local testing;
it does not make them part of the macOS installer.

The repository's **Build** workflow tests and builds Windows and both macOS
architectures on pushes to `main` or manual runs. Download the resulting installers
from the workflow artifacts. Publishing a GitHub release is a separate step.

## Tests

```bash
npm test
```

The default suite checks download recovery, progress, settings and queue behavior,
then exercises the renderer, sandboxed preload and main-process IPC. Tests use
temporary profiles instead of your real settings.

For broader checks with real tools:

```bash
npm run fetch:bin
npm run test:sanity  # UI controls, local downloads, formats and postprocessing
npm run test:smoke   # live video download and MP3 conversion
npm run test:qa      # live site matrix and pause/resume/cancel
```

Live checks require network access and may fail when a host requires sign-in,
blocks a request or removes a sample. Logs, downloaded fixtures and screenshots
are saved under `release/` and are not committed.

## Cookies and troubleshooting

Leave **Use cookies from** set to **No browser** for public videos. For sign-in-only
media, choose a browser where you are signed in, or select a Netscape-format
`cookies.txt` file in Settings. A selected cookies file takes precedence over the
browser setting. Keep exported cookies private: they contain session credentials.

On Windows, Chromium browser cookie encryption can prevent yt-dlp from reading
Chrome, Edge or Brave cookies. Try Firefox or an exported cookies file. If a
browser database is locked, close that browser and retry.

When a site stops working, update yt-dlp in Settings first. If a quality is
unavailable, choose the best available quality. Grabber retries some temporary
cookie and HTTP 403 failures once; persistent host restrictions still require
your attention. Download logs contain the engine's detailed error output.

| Data | Windows | macOS |
| --- | --- | --- |
| Default downloads | `%USERPROFILE%\Downloads` | `~/Downloads` |
| Settings and managed tools | `%APPDATA%\Grabber` | `~/Library/Application Support/Grabber` |

## Contributing

Bug reports and pull requests are welcome. Include your operating system, Grabber
version, steps to reproduce and relevant logs. Remove cookies, tokens and private
URLs before sharing logs. Run `npm test` before submitting code changes, and run
the relevant integration checks when changing downloads or packaging.

```text
src/main/binaries.js    Tool discovery, installation and updates
src/main/probe.js       Link metadata and playlist inspection
src/main/engine.js      Runtime, cookies and retry policy
src/main/downloader.js  Queue, progress and pause/resume/cancel
src/main/store.js       Settings and history
src/preload/preload.js  Sandboxed IPC bridge
src/renderer/          HTML, CSS and JavaScript interface
scripts/               Tool fetching and macOS signing
test/                  Regression, UI and integration checks
```

The renderer uses context isolation and sandboxing. System access goes through
the preload bridge and named IPC channels.

## License

Grabber's source code is licensed under the [MIT License](LICENSE), copyright
2026 Arslan Rasheed. You may use, modify and redistribute it, including
commercially, while retaining the copyright and license notice.

Electron and downloaded tools retain their own licenses; Grabber's MIT license
does not relicense them. See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

# Grabber

A desktop front end for [yt-dlp](https://github.com/yt-dlp/yt-dlp). Paste a link from
just about any video site, pick a quality, and watch it download. Runs on Windows and macOS.

Grabber installs the tools it needs by itself. There is no Python to set up, no ffmpeg to
put on your PATH, and nothing to configure before the first download.
YouTube's JavaScript challenges use the Node runtime already included with Electron;
you do not need a separate Node or Deno installation to run a packaged Grabber app.

## Running it from source

```bash
npm install
npm start
```

Every launch opens with a system check — the OS, the download folder, and each tool the app
needs, checked in front of you. If anything is missing, one click installs it into Grabber's
own application-data folder: by direct download first, and if that cannot get through, via
`winget` on Windows or Homebrew on macOS. Nothing is installed system-wide and nothing
already on your machine is modified.

The app also refuses to stay dependent on tools it does not own. If a check finds it
borrowing a system-installed copy from PATH, it quietly installs its own — so uninstalling
the system one later cannot break the app. If a tool vanishes mid-session, the next download
attempt reopens the system check instead of failing with an error.

### On a Mac

Everything you need is Node 18 or newer. Nothing is committed that is platform-specific.

```bash
git clone https://github.com/ArslanRasheed60/grabber-the-downloader.git
cd grabber-the-downloader
npm install
npm start          # run it
npm test           # or check the suite first
npm run dist:mac   # build a .dmg for Apple Silicon (dist:mac-intel for Intel)
```

The app figures out on its own that it is on macOS and fetches the Apple Silicon or Intel
builds of its tools to match.

If you would rather not build locally, the **Actions** tab does it for you: the `Build`
workflow produces the `.dmg` on a macOS runner and attaches it to the run. Trigger it with
*Run workflow*, then download `grabber-macos-arm64` from the finished run.

The build is signed ad-hoc rather than with a Developer ID, so the first launch needs
right-click → Open. If macOS instead claims the app is damaged, that is the quarantine flag
from having downloaded it — clear it once:

```bash
xattr -cr /Applications/Grabber.app
```

## Building installers

```bash
npm run dist:win        # Windows x64 installer (.exe)
npm run dist:mac        # macOS Apple Silicon (.dmg + .zip)
npm run dist:mac-intel  # macOS Intel
```

Each of those first runs `scripts/fetch-binaries.js`, which pulls the right yt-dlp, ffmpeg
and ffprobe builds for the target platform into `resources/bin/`. electron-builder then
ships them inside the installer, so the app works offline the moment it is installed.

You can also skip the prefetch entirely (`npx electron-builder --win`) and let the app
download its tools on first run.

Two things to know before you ship a build:

- **`resources/bin` is not emptied between targets.** Run `dist:win` and then `dist:mac` on
  the same checkout and the Mac artifact carries the Windows binaries too. Delete the folder
  between targets.
- **Building for macOS has to happen on a Mac.** That is an Apple restriction, not a Grabber
  one. With no Developer ID configured, `scripts/adhoc-sign.js` ad-hoc signs the bundle after
  packaging — Apple Silicon refuses to launch an arm64 app with no signature at all, so this
  is what makes the build runnable rather than merely untrusted. Users still need right-click
  → Open the first time. Set `CSC_LINK`/`CSC_NAME` and the hook stands aside so
  electron-builder signs with your real certificate.

## Tests

```bash
npm test
```

This runs the queue/settings checks and deterministic download-recovery tests (cookie
access failures, HTTP 403 retries, canceled jobs, and tool-update selection).
An optional live check downloads a public video through the real queue, verifies the
complete audio/video streams with ffprobe, then checks MP3 conversion:

```bash
npm run test:smoke
npm run test:smoke -- "https://www.youtube.com/watch?v=VIDEO_ID" --quality=360
```

The live check uses a temporary settings profile and saves its media and logs under
`release/smoke-*`. It requires installed download tools and network access.

`npm test` also exercises the renderer, sandboxed preload and IPC in a hidden window.
For a broader live matrix plus real pause/resume/cancel checks, run `npm run test:qa`.
It saves media, logs and a report under `release/qa-*`; restricted or unavailable
samples are reported explicitly. See [QA-report.md](QA-report.md) for the latest run.

`npm run test:sanity` exercises every app button/control through the renderer and IPC,
all four container choices, all six audio choices, and metadata/cover/chapter/subtitle/
sponsor-cut postprocessing with local fixtures. Native dialog selections and external
app launches are intercepted. It saves results under `release/sanity-*`.
The final release check is documented in [SANITY-report.md](SANITY-report.md).

MP4 and MKV selections remux combined streams as needed. WebM prefers compatible
streams and converts when necessary, which can take longer. WAV and WebM downloads
skip embedded cover art because those containers do not support it.

Covers the parts that are easy to get wrong and hard to see by reading:

- the progress meter, against lines captured from real yt-dlp runs — it must only ever rise,
  even though a `bv*+ba` download arrives as two separate streams each reported from zero;
- playlist output paths, which decide the folder name and the ordering;
- a download deleted while running staying deleted;
- the interface never naming yt-dlp (see "Naming" below).

## Naming

The interface calls yt-dlp "the download engine" and never names it — including in text the
app does not write, such as engine output shown in a download's log. `scrubToolNames()` in
`src/main/util.js` is the single choke point for that, and the test suite asserts it. Code,
comments, filenames and this README use the real name.

## What it does

- **Any site yt-dlp supports.** Roughly 1,800 extractors — YouTube, Vimeo, TikTok, X,
  Instagram, Reddit, Twitch, SoundCloud, and a very long tail beyond those.
- **Paste and go.** Pasting a link into the field starts it. Press Enter if you typed one.
- **Several at once.** Paste a block of links, one per line, and each is queued separately.
- **Playlists and channels.** Flip on *Whole playlist* and every video is queued into a
  folder named after the playlist, numbered in order. Anything over 25 videos asks first.
- **Real progress.** Byte counts, transfer rate and time remaining come from yt-dlp's
  machine-readable progress stream, not from scraping its text output. Video and audio
  arrive as separate streams, and the meter accounts for both so it fills once.
- **Audio only.** One chip switches to audio and converts to MP3, M4A, Opus, FLAC or WAV.
- **Pause, resume, cancel.** Pausing stops the transfer and keeps the partial file; resuming
  picks up where it left off rather than starting over.
- **Sign-in-only videos.** Point *Use cookies from* at a browser you are signed into, or
  *Cookies file* at an exported `cookies.txt`. See below — on Windows the browser option
  mostly does not work, and that is not something Grabber can fix.
- **Extras.** Cover art, metadata, chapters and subtitles are embedded into the file.
  SponsorBlock segments can be cut automatically.
- **A log per download.** The list icon on any row opens exactly what yt-dlp reported.

## Cookies, and why YouTube keeps asking you to sign in

YouTube increasingly answers *"Sign in to confirm you're not a bot"* to anyone it does not
recognise. The fix is to give yt-dlp your cookies. On Windows that is harder than it sounds:

**Chrome, Edge, Brave and Opera will not work on Windows.** Since Chrome 127 the Chromium
browsers protect their cookie store with App-Bound Encryption, and yt-dlp cannot read it —
you get `Failed to decrypt with DPAPI`. Closing the browser does not help. This is upstream
([yt-dlp#10927](https://github.com/yt-dlp/yt-dlp/issues/10927)), not something the app can
work around. macOS is unaffected.

Two things that do work:

1. **Firefox.** Its cookies are not encrypted this way. Sign into YouTube in Firefox, then
   set *Use cookies from* → Firefox. Close Firefox first, or its database will be locked.
2. **A cookies file.** Install a `cookies.txt` extension in whichever browser you are signed
   into, export while on youtube.com, then point *Cookies file* at the result with **Browse**.
   A file set here overrides the browser choice. Re-export when it stops working — YouTube
   cookies expire.

Keep the file to yourself: it grants access to your signed-in session.

Leave *Use cookies from* at *No browser* for public videos. If a selected browser's
cookie database cannot be copied or decrypted, Grabber retries that request once without
browser cookies and explains what happened. Your saved browser choice is preserved, and
an explicitly selected cookies file is never silently ignored.

## Keeping yt-dlp current

Sites change constantly and yt-dlp ships fixes almost daily. **Settings → Update yt-dlp**
fetches the newest release. If a site suddenly stops working, do that first — it is the fix
most of the time.

Grabber selects the newer of its bundled and downloaded engines, so an older installer
cannot hide an update, and a newer installer cannot be overridden by an older downloaded
copy. An explicit update switches away from any custom engine path. Failed tool checks
fall back to another working copy.

## Where things go

| | Windows | macOS |
|---|---|---|
| Downloads | `%USERPROFILE%\Downloads` | `~/Downloads` |
| Settings and tools | `%APPDATA%\Grabber` | `~/Library/Application Support/Grabber` |

The download folder is configurable in Settings.

## When something fails

The row turns red and states the problem. The common ones:

- **"This site wants a signed-in session"** — set *Use cookies from* to a browser where you
  are logged in. Close that browser first; Chrome locks its cookie database while running.
- **"No extractor handles this link"** — the page may embed video from somewhere else. Try
  the direct link, or update yt-dlp.
- **"That quality is not published for this video"** — pick *Best video*.
- **"HTTP Error 403: Forbidden"** — the host refused a media request; this is not a
  Chrome cache error. Grabber refreshes media links and checks available formats once
  before reporting a failure. YouTube downloads use bounded HTTP requests to avoid
  rejected or stalled full-file requests. Update the engine if the error persists;
  sign-in requirements and host-side restrictions can still prevent a download.
- **The host blocks your region** — set a proxy in Settings.

## How it is put together

```
src/main/binaries.js    finds or downloads yt-dlp, ffmpeg, ffprobe
src/main/probe.js       reads a link with `yt-dlp -J` before anything is queued
src/main/engine.js      shared runtime, cookie and request/retry policy
src/main/downloader.js  the queue: spawning, progress parsing, pause/resume/cancel
src/main/store.js       settings and history on disk
src/preload/preload.js  the only bridge between the page and the system
src/renderer/           the interface — plain HTML, CSS and JS, no build step
```

The renderer has no Node access: `contextIsolation` and `sandbox` are on, and every
privileged action goes through a named channel in the preload bridge.

## Licence

MIT for this wrapper. yt-dlp (Unlicense) and ffmpeg (GPL/LGPL) are downloaded at build or
first-run time and keep their own licences — this project does not redistribute them.

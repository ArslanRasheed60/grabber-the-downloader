# Grabber

A desktop front end for [yt-dlp](https://github.com/yt-dlp/yt-dlp). Paste a link from
just about any video site, pick a quality, and watch it download. Runs on Windows and macOS.

Grabber installs the tools it needs by itself. There is no Python to set up, no ffmpeg to
put on your PATH, and nothing to configure before the first download.

## Running it from source

```bash
npm install
npm start
```

On first launch, Grabber checks for `yt-dlp` and `ffmpeg`. If they are missing it downloads
them into its own application-data folder and reports progress while it does. Nothing is
installed system-wide and nothing already on your machine is modified.

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
builds of its tools to match. The first launch of a packaged build needs right-click → Open,
because it is signed ad-hoc rather than with a Developer ID.

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
- **Sign-in-only videos.** Point *Use cookies from* at a browser you are logged into and
  private, age-restricted and members-only videos work.
- **Extras.** Cover art, metadata, chapters and subtitles are embedded into the file.
  SponsorBlock segments can be cut automatically.
- **A log per download.** The list icon on any row opens exactly what yt-dlp reported.

## Keeping yt-dlp current

Sites change constantly and yt-dlp ships fixes almost daily. **Settings → Update yt-dlp**
fetches the newest release. If a site suddenly stops working, do that first — it is the fix
most of the time.

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
- **The host blocks your region** — set a proxy in Settings.

## How it is put together

```
src/main/binaries.js    finds or downloads yt-dlp, ffmpeg, ffprobe
src/main/probe.js       reads a link with `yt-dlp -J` before anything is queued
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

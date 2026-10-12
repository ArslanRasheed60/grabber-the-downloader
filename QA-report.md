# Grabber 1.3.2 QA — 12 October 2026

Core QA passed on Windows x64. Real downloads passed on six services. The Vimeo
sample could be read through its public embedded player, but its media streams
were reported as DRM protected and could not be downloaded.

## Automated and interface checks

- 18 recovery tests passed, including browser-cookie failures, bounded 403 retries,
  tool selection/cache invalidation, preparation cancellation, rapid pause/resume,
  and Vimeo fallback/authentication boundaries.
- All 95 existing application checks passed.
- A hidden Electron window exercised the actual renderer, sandboxed preload and
  main-process IPC. Startup, settings persistence/clamping, quality selection,
  failed rows, log display, HTML-safe rendering and row removal passed.
- Real local-media interruption checks passed. Resume made an HTTP Range request
  and preserved the partial download; Cancel stopped the running process.

## Real download matrix

Each successful output was checked for audio/video streams, complete duration,
and successful decoding of its first two seconds. Public links were tested with
no browser cookies. The download engine was the bundled release 2026.08.19.

| Service / output | Result |
|---|---|
| YouTube MP4, best available | Passed |
| YouTube MP3 | Passed |
| YouTube MKV | Passed |
| YouTube M4A | Passed |
| Dailymotion MP4 | Passed |
| TikTok MP4 | Passed |
| X/Twitter MP4 | Passed |
| Reddit MP4 | Passed |
| SoundCloud MP3 | Passed |
| Vimeo sample 76979871 | Failed: streams reported DRM protected |

Vimeo was also checked directly with the engine's format validation. All offered
formats for this sample failed with the same protection error. No decryption or
protection bypass was attempted. Initial obsolete test links were replaced; their
original failures remain in the earlier QA output folders.

## Fixes found during QA

1. Pause/Cancel during Preparing could still allow the process to start. Pending
   preparations now stop, and rapid resume cannot revive an older start attempt.
2. Missing videos and Vimeo sign-in errors were described poorly. They now receive
   specific messages.
3. Vimeo's public watch-page client can require sign-in while its equivalent public
   player still exposes metadata. The app now tries that player only for the specific
   web-client error; private/password errors keep their authentication requirements.

## Evidence and scope

- Raw final download results/logs: `release/qa-1791825056790/`.
- Automated/UI log: `release/diagnostics/qa-final-unit.log`.
- UI screenshot: `release/ui-qa-1791825082371/queue.png`.
- Updated installer: `release/Grabber-1.3.2-win-x64.exe`.

macOS/Linux execution, the installation wizard, signed-in videos, every quality,
and every supported service were not exercised. These representative checks do
not guarantee that all videos or future site changes will work.

Run `npm test` for automated/UI checks or `npm run test:qa` for the live matrix.
The latter downloads media, uses a temporary app profile, and saves results under
`release/qa-*`. Its exit code is nonzero when a sample fails, including host restrictions.

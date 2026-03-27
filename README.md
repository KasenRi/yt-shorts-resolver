# yt-shorts-resolver

Chrome extension branch that injects a `解析下载` button directly into YouTube and produces a usable media file instead of only exposing a raw stream URL.

Branch: `feature/chrome-extension`

## Current Capability

- Injects a `解析下载` button on YouTube watch pages and Shorts pages
- Resolves direct progressive formats when YouTube exposes a single file with audio + video
- Falls back to adaptive streams and merges separate video/audio tracks locally inside the extension
- Supports mixed-container adaptive pairs by copying the video stream and transcoding audio when the output container requires it
- Uses the active browser session instead of a remote VPS resolver
- Tracks button progress for resolve, direct download, fetch, merge, and save stages
- Rejects oversized browser-side merge jobs before pulling unbounded media into memory

## Architecture

1. `content.js` injects the button and forwards requests
2. `page-bridge.js` runs in the page context and extracts stream candidates from:
   - `movie_player.getPlayerResponse()`
   - `ytInitialPlayerResponse`
   - `formats + adaptiveFormats`
   - player JS when `signatureCipher` must be deciphered
   - fetched watch-page HTML as a same-session fallback
   - `youtubei/v1/player` as a same-page fallback
3. `background.js` chooses between:
   - direct browser download for progressive media with `chrome.downloads` progress tracking and startup fallbacks
   - offscreen merge workflow for adaptive audio/video pairs
4. `offscreen.js` + `lib/merge-media.js` fetch streams, enforce merge budgets, run `ffmpeg.wasm`, and hand the merged blob back to the browser download manager when available

## Files

- Extension manifest: [extension/manifest.json](/home/ribon/yt-shorts-resolver/extension/manifest.json)
- Content script: [extension/content.js](/home/ribon/yt-shorts-resolver/extension/content.js)
- Page bridge: [extension/page-bridge.js](/home/ribon/yt-shorts-resolver/extension/page-bridge.js)
- Background worker: [extension/background.js](/home/ribon/yt-shorts-resolver/extension/background.js)
- Offscreen merge page: [extension/offscreen.js](/home/ribon/yt-shorts-resolver/extension/offscreen.js)
- Merge helper: [extension/lib/merge-media.js](/home/ribon/yt-shorts-resolver/extension/lib/merge-media.js)

## Load In Chrome

1. Run `npm install`
2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select the [extension](/home/ribon/yt-shorts-resolver/extension) directory

Then open a YouTube watch page or Shorts page and use the `解析下载` button near the action bar.

## Tests

Page-resolution fixture test:

```bash
npm run test:fixture
```

Browser-side merge test with real `ffmpeg.wasm`:

```bash
npm run test:merge
```

Actual unpacked-extension smoke test with the full background + offscreen pipeline:

```bash
xvfb-run -a npm run test:chrome
```

The current automated coverage verifies:

- direct progressive download selection
- direct-download progress state propagation back to the injected button
- adaptive-format selection as a merge job instead of a silent video download
- mixed-container adaptive selection with audio transcode fallback
- budget-aware adaptive pair selection when the highest-quality pair exceeds browser merge limits
- clear resolve failure when every adaptive pair exceeds the browser merge budget
- `signatureCipher` handling for adaptive URLs
- watch-page fallback parsing
- real browser-side media merge using `ffmpeg.wasm`
- real unpacked extension execution through content script, background worker, offscreen page, and actual downloaded files for both direct and merge paths

## Limitation

This branch is intentionally browser-side because server-side extraction on many VPS IPs now triggers YouTube bot checks.

The extension can now merge split tracks locally, but it still depends on whatever streams YouTube exposes in the active browser session. If YouTube only exposes incompatible adaptive pairs, or fully blocks playback metadata, the extension fails fast instead of pretending a valid final download exists.

Browser-side merging is intentionally bounded. The current guardrails are `256 MB` per single input stream and `384 MB` total for one merge job, so very large videos may still fail locally even when stream URLs resolve successfully.

In this environment, deterministic local extension smoke tests now pass. Real public YouTube pages can still be affected by network access limits, account state, or anti-bot challenges outside the extension code itself.

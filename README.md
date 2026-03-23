# yt-shorts-resolver

Single-tool Chrome extension branch for adding a `解析下载` button directly inside YouTube.

Branch: `feature/chrome-extension`

## Approach

This branch removes the VPS dependency. The extension resolves media links inside the user's own YouTube tab by using the page's own session, cookies, and player state.

Flow:

1. content script injects a `解析下载` button next to the YouTube action bar
2. page bridge script runs in the page context and reads:
   - `movie_player.getPlayerResponse()`
   - `ytInitialPlayerResponse`
   - active `video.currentSrc`
   - `youtubei/v1/player` as a same-page fallback
3. background service worker uses `chrome.downloads.download()` to start the file download

## Files

- Extension manifest: [extension/manifest.json](/home/ribon/yt-shorts-resolver/extension/manifest.json)
- Content script: [extension/content.js](/home/ribon/yt-shorts-resolver/extension/content.js)
- Page bridge: [extension/page-bridge.js](/home/ribon/yt-shorts-resolver/extension/page-bridge.js)
- Background worker: [extension/background.js](/home/ribon/yt-shorts-resolver/extension/background.js)

## Load In Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the [extension](/home/ribon/yt-shorts-resolver/extension) directory

Then open a YouTube watch page or Shorts page and look for the `解析下载` button near the existing action buttons.

## Tests

Real extension injection test against the provided Shorts URL:

```bash
xvfb-run -a npm run test:chrome
```

Local fixture test for the full extension message chain:

```bash
npm run test:fixture
```

## Current Limitation

This branch is intentionally browser-side because server-side extraction on many VPS IPs now triggers YouTube bot checks.

The extension is materially better than a VPS resolver because it uses the user's own browsing session, but it still depends on whatever direct formats YouTube exposes in the active page context. When YouTube withholds progressive URLs, this branch will fail fast instead of pretending that a stable direct MP4 exists.

In this environment, automated unpacked-extension loading was reliable with Playwright's bundled Chromium. The extension itself remains MV3 Chrome-compatible and can still be loaded manually in Google Chrome through `chrome://extensions`.

For the provided test URL (`https://youtube.com/shorts/I30NoCSaZ2M?si=pA7R2ywBYqKtYpeS`), automated browser runs currently receive YouTube's `Sign in to confirm you’re not a bot` playability response. The extension now surfaces that state immediately instead of hanging on a resolver timeout.

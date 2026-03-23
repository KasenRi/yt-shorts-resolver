# yt-shorts-resolver

Tampermonkey script + backend API for adding a `解析下载` button to YouTube pages.

## What It Does

- Injects a `解析下载` button next to the YouTube action bar.
- Calls your backend at `POST /api/resolve`.
- On success, opens the resolved media URL in a new tab.

## Architecture

- Client: [tampermonkey/youtube-download.user.js](/home/ribon/yt-shorts-resolver/tampermonkey/youtube-download.user.js)
- Server: [src/server.js](/home/ribon/yt-shorts-resolver/src/server.js)
- Providers:
  - `yt-dlp`
  - `cobalt`
  - `fixture` for UI testing only

## Important Limitation

YouTube now aggressively blocks server-side extraction on many IPs. In practice, a stable deployment often needs at least one of these:

- browser cookies via `YTDLP_COOKIES_FILE`
- `--cookies-from-browser` on the same machine
- a cleaner residential / mobile proxy via `YTDLP_PROXY`
- a self-hosted `cobalt` upstream with working session / poToken support

On this machine, the provided Shorts URL hit YouTube's `Sign in to confirm you're not a bot` gate for raw server-side extraction, so the project is implemented as a deployable resolver with configurable backends rather than pretending that a clean unauthenticated server IP will always work.

## Local Run

```bash
npm install
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Resolve:

```bash
curl http://127.0.0.1:8787/api/resolve \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://youtube.com/shorts/I30NoCSaZ2M?si=pA7R2ywBYqKtYpeS"}'
```

## Docker One-Command Deploy

```bash
docker compose up -d --build
```

Default backend is `yt-dlp`. Recommended environment variables:

```bash
export RESOLVER_PROVIDER=yt-dlp
export YTDLP_PROXY=http://your-proxy:port
export YTDLP_COOKIES_FILE=/run/secrets/youtube-cookies.txt
docker compose up -d --build
```

If you already have a working cobalt instance:

```bash
export RESOLVER_PROVIDER=cobalt
export UPSTREAM_COBALT_BASE_URL=https://your-cobalt-api.example
export UPSTREAM_COBALT_AUTH_HEADER='Authorization value if needed'
docker compose up -d --build
```

## Tampermonkey Install

Load [tampermonkey/youtube-download.user.js](/home/ribon/yt-shorts-resolver/tampermonkey/youtube-download.user.js) into Tampermonkey.

If your backend is not running on `http://127.0.0.1:8787`, update `SERVER_BASE` near the top of the script.

## Chrome Test

UI injection test:

```bash
npm run e2e
```

This uses the `fixture` response path to verify the Chrome-side injection flow with the exact Shorts page URL, without claiming that YouTube extraction succeeded from this environment.

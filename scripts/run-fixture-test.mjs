import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";

function fixtureHtml(body) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Fixture - YouTube</title>
  </head>
  <body>
    <ytd-app>
      <ytd-reel-player-overlay-renderer>
        <div id="actions"></div>
      </ytd-reel-player-overlay-renderer>
      <div id="movie_player"></div>
      <video></video>
    </ytd-app>
    ${body}
  </body>
</html>`;
}

function progressiveFixture(origin) {
  const response = {
    videoDetails: {
      title: "Fixture Shorts",
    },
    streamingData: {
      formats: [
        {
          qualityLabel: "720p",
          height: 720,
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          url: `${origin}/media/fixture.mp4`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};
    </script>
  `);
}

function adaptiveFixture(origin) {
  const response = {
    videoDetails: {
      title: "Adaptive Fixture",
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "1080p",
          height: 1080,
          bitrate: 3200000,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          signatureCipher: `url=${encodeURIComponent(`${origin}/media/adaptive-video.mp4?source=fixture`)}&sp=sig&s=12345`,
        },
        {
          bitrate: 192000,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: `${origin}/media/adaptive-audio.m4a`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};

      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Adaptive Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function adaptiveMixedFixture(origin) {
  const response = {
    videoDetails: {
      title: "Mixed Adaptive Fixture",
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "1440p",
          height: 1440,
          bitrate: 4200000,
          mimeType: 'video/webm; codecs="vp9"',
          url: `${origin}/media/mixed-video.webm`,
        },
        {
          bitrate: 192000,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: `${origin}/media/mixed-audio.m4a`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};

      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Mixed Adaptive Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function adaptiveBudgetFixture(origin) {
  const response = {
    videoDetails: {
      title: "Budget Adaptive Fixture",
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "2160p",
          height: 2160,
          bitrate: 5200000,
          mimeType: 'video/mp4; codecs="avc1.640033"',
          url: `${origin}/media/budget-video-large.mp4`,
          contentLength: String(240 * 1024 * 1024),
        },
        {
          qualityLabel: "1080p",
          height: 1080,
          bitrate: 3200000,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          url: `${origin}/media/budget-video-safe.mp4`,
          contentLength: String(180 * 1024 * 1024),
        },
        {
          bitrate: 192000,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: `${origin}/media/budget-audio.m4a`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
          contentLength: String(200 * 1024 * 1024),
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};

      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Budget Adaptive Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function adaptiveOverBudgetFixture(origin) {
  const response = {
    videoDetails: {
      title: "Over Budget Fixture",
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "2160p",
          height: 2160,
          bitrate: 5200000,
          mimeType: 'video/mp4; codecs="avc1.640033"',
          url: `${origin}/media/over-budget-video.mp4`,
          contentLength: String(240 * 1024 * 1024),
        },
        {
          bitrate: 192000,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: `${origin}/media/over-budget-audio.m4a`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
          contentLength: String(200 * 1024 * 1024),
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};

      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Over Budget Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function watchFallbackFixture() {
  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = null;
      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Watch Fallback Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function performanceObservedFixture(origin) {
  const response = {
    videoDetails: {
      title: "Performance Observed Fixture",
    },
    streamingData: {
      formats: [
        {
          qualityLabel: "720p",
          height: 720,
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          url: `${origin}/media/performance-raw.mp4?id=fixture-observed-id&n=raw-token`,
          audioQuality: "AUDIO_QUALITY_MEDIUM",
        },
      ],
    },
  };

  return fixtureHtml(`
    <script>
      window.ytInitialPlayerResponse = ${JSON.stringify(response)};

      const moviePlayer = document.getElementById("movie_player");
      moviePlayer.getPlayerResponse = () => null;
      moviePlayer.getVideoData = () => ({ title: "Performance Observed Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });

      const originalGetEntriesByType = performance.getEntriesByType.bind(performance);
      performance.getEntriesByType = (type) => {
        const entries = originalGetEntriesByType(type);
        if (type !== "resource") {
          return entries;
        }

        return entries.concat([
          {
            name: "https://rr1---sn-fixture.googlevideo.com/videoplayback?id=fixture-observed-id&n=live-token",
            responseEnd: 1200,
            transferSize: 1024,
            encodedBodySize: 768,
          },
        ]);
      };
    </script>
  `);
}

async function createServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const requestUrl = request.url || "/";

      if (requestUrl === "/player.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        response.end(`
          var XY={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)},Sw:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}};
          function de(a){a=a.split("");XY.Rv(a);XY.Sp(a,1);XY.Sw(a,2);return a.join("")}
          function probe(a){return a.sig||de(a.s)}
        `);
        return;
      }

      if (requestUrl.startsWith("/watch?v=watch-fixture")) {
        const responsePayload = {
          videoDetails: {
            title: "Watch Fallback Fixture",
          },
          streamingData: {
            formats: [
              {
                qualityLabel: "360p",
                height: 360,
                mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
                url: `${origin}/media/watch.mp4`,
                audioQuality: "AUDIO_QUALITY_MEDIUM",
              },
            ],
          },
        };

        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fixtureHtml(`
          <script>
            var ytInitialPlayerResponse = ${JSON.stringify(responsePayload)};
          </script>
        `));
        return;
      }

      if (
        requestUrl === "/media/fixture.mp4"
        || requestUrl.startsWith("/media/adaptive-video.mp4")
        || requestUrl === "/media/adaptive-audio.m4a"
        || requestUrl === "/media/watch.mp4"
        || requestUrl.startsWith("/media/performance-raw.mp4")
        || requestUrl === "/media/mixed-video.webm"
        || requestUrl === "/media/mixed-audio.m4a"
        || requestUrl === "/media/budget-video-large.mp4"
        || requestUrl === "/media/budget-video-safe.mp4"
        || requestUrl === "/media/budget-audio.m4a"
        || requestUrl === "/media/over-budget-video.mp4"
        || requestUrl === "/media/over-budget-audio.m4a"
      ) {
        response.writeHead(200, {
          "content-type": requestUrl.endsWith(".m4a")
            ? "audio/mp4"
            : requestUrl.endsWith(".webm")
              ? "video/webm"
              : "video/mp4",
        });
        response.end("fixture");
        return;
      }

      if (requestUrl === "/shorts/progressive") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(progressiveFixture(origin));
        return;
      }

      if (requestUrl === "/shorts/adaptive") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(adaptiveFixture(origin));
        return;
      }

      if (requestUrl === "/shorts/adaptive-mixed") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(adaptiveMixedFixture(origin));
        return;
      }

      if (requestUrl === "/shorts/adaptive-budget") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(adaptiveBudgetFixture(origin));
        return;
      }

      if (requestUrl === "/shorts/adaptive-over-budget") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(adaptiveOverBudgetFixture(origin));
        return;
      }

      if (requestUrl === "/shorts/watch-fixture") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(watchFallbackFixture());
        return;
      }

      if (requestUrl === "/shorts/performance-observed") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(performanceObservedFixture(origin));
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });

    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function runCase(page, url, expected) {
  await page.evaluate(() => {
    window.__downloadRequests__ = [];
    window.__statusEvents__ = [];
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(800);

  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 5000 });
  await button.click();

  let result = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    result = await page.evaluate(() => ({
      text: document.querySelector("button.ytr-resolve-download-button")?.textContent || "",
      title: document.querySelector("button.ytr-resolve-download-button")?.title || "",
      requests: window.__downloadRequests__ || [],
      statusEvents: window.__statusEvents__ || [],
    }));

    const latestRequest = result.requests[result.requests.length - 1];
    const completed = result.statusEvents.some((event) => event.phase === "complete");

    if (latestRequest?.payload?.request?.mode === expected.mode) {
      if (expected.mode === "direct" && !expected.tracking && result.text === "已开始下载") {
        break;
      }

      if ((expected.mode === "direct" && expected.tracking && completed) || (expected.mode === "merge" && completed)) {
        break;
      }
    }

    await page.waitForTimeout(100);
  }

  const latest = result.requests[result.requests.length - 1];
  if (!latest) {
    throw new Error(`Expected a download request for ${url}`);
  }

  if (latest.type !== "start-download") {
    throw new Error(`Expected start-download message for ${url}, got ${latest.type || "none"}`);
  }

  const request = latest.payload?.request;
  if (request?.mode !== expected.mode) {
    throw new Error(`Expected ${expected.mode} mode for ${url}, got ${request?.mode || "none"}`);
  }

  if (expected.mode === "direct") {
    if (expected.tracking) {
      const completed = result.statusEvents.find((event) => event.phase === "complete");
      if (!completed || result.text !== "已保存") {
        throw new Error(`Expected tracked direct completion for ${url}, got ${result.text} (${result.title || "no-title"})`);
      }
    } else if (result.text !== "已开始下载") {
      throw new Error(`Expected direct success state for ${url}, got ${result.text} (${result.title || "no-title"})`);
    }

    if (!request?.directUrl || !request.directUrl.includes(expected.directUrlPart)) {
      throw new Error(`Expected resolved URL to include ${expected.directUrlPart}, got ${request?.directUrl || "none"}`);
    }
  }

  if (expected.mode === "merge") {
    const completed = result.statusEvents.find((event) => event.phase === "complete");
    if (!completed) {
      throw new Error(`Expected merge completion event for ${url}`);
    }

    if (!request?.video?.url || !request.video.url.includes(expected.videoUrlPart)) {
      throw new Error(`Expected video URL to include ${expected.videoUrlPart}, got ${request?.video?.url || "none"}`);
    }

    if (!request?.audio?.url || !request.audio.url.includes(expected.audioUrlPart)) {
      throw new Error(`Expected audio URL to include ${expected.audioUrlPart}, got ${request?.audio?.url || "none"}`);
    }

    if (request.outputExt !== expected.outputExt) {
      throw new Error(`Expected outputExt ${expected.outputExt}, got ${request.outputExt || "none"}`);
    }

    if (expected.requiresTranscode !== undefined && request.requiresTranscode !== expected.requiresTranscode) {
      throw new Error(`Expected requiresTranscode=${expected.requiresTranscode} for ${url}, got ${request.requiresTranscode}`);
    }
  }

  return {
    url,
    mode: request.mode,
    filename: request.filename || "",
    directUrl: request.directUrl || "",
    videoUrl: request.video?.url || "",
    audioUrl: request.audio?.url || "",
    requiresTranscode: request.requiresTranscode ?? null,
  };
}

async function runErrorCase(page, url, expected) {
  await page.evaluate(() => {
    window.__downloadRequests__ = [];
    window.__statusEvents__ = [];
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(800);

  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 5000 });
  await button.click();

  let result = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    result = await page.evaluate(() => ({
      text: document.querySelector("button.ytr-resolve-download-button")?.textContent || "",
      title: document.querySelector("button.ytr-resolve-download-button")?.title || "",
      requests: window.__downloadRequests__ || [],
    }));

    if (result.text === "下载失败") {
      break;
    }

    await page.waitForTimeout(100);
  }

  if (result?.text !== "下载失败") {
    throw new Error(`Expected resolve failure for ${url}, got ${result?.text || "none"}`);
  }

  if (result.requests.length > 0) {
    throw new Error(`Expected no start-download request for ${url}, got ${result.requests.length}`);
  }

  if (!result.title.includes(expected.errorIncludes)) {
    throw new Error(`Expected error title for ${url} to include ${expected.errorIncludes}, got ${result.title || "none"}`);
  }

  return {
    url,
    text: result.text,
    title: result.title,
  };
}

async function main() {
  const server = await createServer();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });

  const page = await browser.newPage();
  await page.addInitScript(() => {
    const runtimeListeners = [];
    window.__downloadRequests__ = [];
    window.__statusEvents__ = [];

    function emitRuntimeMessage(message) {
      window.__statusEvents__.push(message);
      for (const listener of runtimeListeners) {
        listener(message, undefined, () => undefined);
      }
    }

    window.chrome = {
      runtime: {
        getURL: (value) => value,
        onMessage: {
          addListener: (listener) => runtimeListeners.push(listener),
        },
        sendMessage: async (message) => {
          window.__downloadRequests__.push(message);
          const request = message?.payload?.request || {};
          const jobId = message?.payload?.jobId;

          if (message?.type === "start-download" && request.mode === "merge") {
            window.setTimeout(() => {
              emitRuntimeMessage({
                type: "download-status",
                jobId,
                phase: "running",
                percent: 0.3,
                text: "下载视频30%",
              });
            }, 10);

            window.setTimeout(() => {
              emitRuntimeMessage({
                type: "download-status",
                jobId,
                phase: "running",
                percent: 0.8,
                text: "合并中80%",
              });
            }, 30);

            window.setTimeout(() => {
              emitRuntimeMessage({
                type: "download-status",
                jobId,
                phase: "complete",
                text: "已保存",
              });
            }, 60);

            return { ok: true, mode: "merge", tracking: true, text: "准备合并..." };
          }

          if (message?.type === "start-download" && request.mode === "direct") {
            window.setTimeout(() => {
              emitRuntimeMessage({
                type: "download-status",
                jobId,
                phase: "running",
                percent: 0.35,
                text: "下载中35%",
              });
            }, 10);

            window.setTimeout(() => {
              emitRuntimeMessage({
                type: "download-status",
                jobId,
                phase: "complete",
                text: "已保存",
              });
            }, 40);

            return { ok: true, mode: "direct", tracking: true, text: "开始下载..." };
          }

          return { ok: true, mode: "direct" };
        },
      },
    };
  });

  await page.addInitScript({ path: fileURLToPath(new URL("../extension/page-bridge.js", import.meta.url)) });
  await page.addInitScript({ path: fileURLToPath(new URL("../extension/content.js", import.meta.url)) });

  const cases = [
    await runCase(page, `${origin}/shorts/progressive`, {
      mode: "direct",
      tracking: true,
      directUrlPart: "/media/fixture.mp4",
    }),
    await runCase(page, `${origin}/shorts/adaptive`, {
      mode: "merge",
      videoUrlPart: "/media/adaptive-video.mp4",
      audioUrlPart: "/media/adaptive-audio.m4a",
      outputExt: "mp4",
      requiresTranscode: false,
    }),
    await runCase(page, `${origin}/shorts/adaptive-mixed`, {
      mode: "merge",
      videoUrlPart: "/media/mixed-video.webm",
      audioUrlPart: "/media/mixed-audio.m4a",
      outputExt: "webm",
      requiresTranscode: true,
    }),
    await runCase(page, `${origin}/shorts/adaptive-budget`, {
      mode: "merge",
      videoUrlPart: "/media/budget-video-safe.mp4",
      audioUrlPart: "/media/budget-audio.m4a",
      outputExt: "mp4",
      requiresTranscode: false,
    }),
    await runCase(page, `${origin}/shorts/watch-fixture`, {
      mode: "direct",
      tracking: true,
      directUrlPart: "/media/watch.mp4",
    }),
    await runCase(page, `${origin}/shorts/performance-observed`, {
      mode: "direct",
      tracking: true,
      directUrlPart: "n=live-token",
    }),
  ];

  const errorCases = [
    await runErrorCase(page, `${origin}/shorts/adaptive-over-budget`, {
      errorIncludes: "超出浏览器内合并上限",
    }),
  ];

  console.log(JSON.stringify({ ok: true, cases, errorCases }, null, 2));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

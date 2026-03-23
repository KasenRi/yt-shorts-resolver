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
      title: "Fixture Shorts"
    },
    streamingData: {
      formats: [
        {
          qualityLabel: "720p",
          height: 720,
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          url: `${origin}/media/fixture.mp4`,
          audioQuality: "AUDIO_QUALITY_MEDIUM"
        }
      ]
    }
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
      title: "Adaptive Fixture"
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "1080p",
          height: 1080,
          bitrate: 3200000,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          signatureCipher: `url=${encodeURIComponent(`${origin}/media/adaptive.mp4?source=fixture`)}&sp=sig&s=12345`
        }
      ]
    }
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

async function createServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const origin = `http://127.0.0.1:${server.address().port}`;

      if (request.url === "/player.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        response.end(`
          var XY={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)},Sw:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}};
          function de(a){a=a.split("");XY.Rv(a);XY.Sp(a,1);XY.Sw(a,2);return a.join("")}
          function probe(a){return a.sig||de(a.s)}
        `);
        return;
      }

      if (request.url?.startsWith("/watch?v=watch-fixture")) {
        const responsePayload = {
          videoDetails: {
            title: "Watch Fallback Fixture"
          },
          streamingData: {
            formats: [
              {
                qualityLabel: "360p",
                height: 360,
                mimeType: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"',
                url: `${origin}/media/watch.mp4`,
                audioQuality: "AUDIO_QUALITY_MEDIUM"
              }
            ]
          }
        };
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fixtureHtml(`
          <script>
            var ytInitialPlayerResponse = ${JSON.stringify(responsePayload)};
          </script>
        `));
        return;
      }

      if (request.url === "/media/fixture.mp4" || request.url?.startsWith("/media/adaptive.mp4") || request.url === "/media/watch.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end("fixture");
        return;
      }

      if (request.url === "/shorts/progressive") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(progressiveFixture(origin));
        return;
      }

      if (request.url === "/shorts/adaptive") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(adaptiveFixture(origin));
        return;
      }

      if (request.url === "/shorts/watch-fixture") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(watchFallbackFixture());
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

async function runCase(page, url, expectedUrlPart) {
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
      requests: window.__downloadRequests__ || []
    }));
    if (result.text === "已开始下载" || result.text === "解析失败" || result.requests.length > 0) {
      break;
    }
    await page.waitForTimeout(250);
  }

  const latest = result.requests[result.requests.length - 1];
  if (result.text !== "已开始下载") {
    throw new Error(`Expected successful button state for ${url}, got ${result.text} (${result.title || "no-title"})`);
  }

  if (!latest?.payload?.url || !latest.payload.url.includes(expectedUrlPart)) {
    throw new Error(`Expected resolved URL to include ${expectedUrlPart}, got ${latest?.payload?.url || "none"}`);
  }

  return {
    url,
    resolvedUrl: latest.payload.url,
    filename: latest.payload.filename || ""
  };
}

async function main() {
  const server = await createServer();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath()
  });

  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__downloadRequests__ = [];
    window.chrome = {
      runtime: {
        getURL: (value) => value,
        sendMessage: async (message) => {
          window.__downloadRequests__.push(message);
          return { ok: true };
        }
      }
    };
  });

  await page.addInitScript({ path: fileURLToPath(new URL("../extension/page-bridge.js", import.meta.url)) });
  await page.addInitScript({ path: fileURLToPath(new URL("../extension/content.js", import.meta.url)) });

  const cases = [
    await runCase(page, `${origin}/shorts/progressive`, "/media/fixture.mp4"),
    await runCase(page, `${origin}/shorts/adaptive`, "/media/adaptive.mp4"),
    await runCase(page, `${origin}/shorts/watch-fixture`, "/media/watch.mp4"),
  ];

  console.log(JSON.stringify({ ok: true, cases }, null, 2));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

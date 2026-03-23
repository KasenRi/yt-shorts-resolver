import { chromium } from "playwright";
import http from "node:http";
import { fileURLToPath } from "node:url";

const html = `<!doctype html>
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
    </ytd-app>
    <script>
      window.ytInitialPlayerResponse = {
        videoDetails: {
          title: "Fixture Shorts"
        },
        streamingData: {
          formats: [
            {
              qualityLabel: "720p",
              height: 720,
              mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
              url: "https://example.com/media/fixture.mp4",
              audioQuality: "AUDIO_QUALITY_MEDIUM"
            }
          ]
        }
      };
    </script>
  </body>
</html>`;

async function createServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === "/fixture.mp4") {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end("fixture");
        return;
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8"
      });
      response.end(html);
    });

    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function main() {
  const server = await createServer();
  const { port } = server.address();

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome"
  });

  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        getURL: (value) => value,
        sendMessage: async (_message) => ({ ok: true })
      }
    };
  });

  await page.addInitScript({ path: fileURLToPath(new URL("../extension/page-bridge.js", import.meta.url)) });
  await page.addInitScript({ path: fileURLToPath(new URL("../extension/content.js", import.meta.url)) });

  await page.goto(`http://127.0.0.1:${port}/shorts/fixture`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(1000);

  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 5000 });
  await button.click();
  await page.waitForTimeout(500);

  const text = await button.textContent();
  console.log(JSON.stringify({ ok: true, text }, null, 2));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

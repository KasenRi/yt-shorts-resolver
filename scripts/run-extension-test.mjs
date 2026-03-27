import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../extension", import.meta.url));
const userDataDir = fileURLToPath(new URL("../tmp/chrome-extension-profile", import.meta.url));
const downloadsPath = fileURLToPath(new URL("../tmp/chrome-extension-downloads", import.meta.url));
const executablePath = process.env.CHROME_EXECUTABLE_PATH || chromium.executablePath();

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

async function generateWebmFixtureMedia() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });

  const page = await browser.newPage();
  await page.goto("data:text/html,<html><body></body></html>");

  const media = await page.evaluate(async () => {
    function sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function pickMimeType(typeCandidates, fallback) {
      return typeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || fallback;
    }

    async function recordVideoOnly() {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(12);
      const mimeType = pickMimeType(["video/webm;codecs=vp8", "video/webm"], "video/webm");
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) {
          chunks.push(event.data);
        }
      });

      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      recorder.start(150);

      let frame = 0;
      const interval = window.setInterval(() => {
        frame += 1;
        context.fillStyle = frame % 2 === 0 ? "#101010" : "#20b2aa";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "bold 32px sans-serif";
        context.fillText(`Frame ${frame}`, 24, 92);
      }, 60);

      await sleep(1200);
      window.clearInterval(interval);
      recorder.stop();
      await stopped;
      await sleep(250);

      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
    }

    async function recordAudioOnly() {
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const oscillator = audioContext.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440;
      oscillator.connect(destination);

      const mimeType = pickMimeType(["audio/webm;codecs=opus", "audio/webm"], "audio/webm");
      const recorder = new MediaRecorder(destination.stream, { mimeType });
      const chunks = [];

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) {
          chunks.push(event.data);
        }
      });

      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      await audioContext.resume();
      recorder.start(150);
      oscillator.start();

      await sleep(1200);
      oscillator.stop();
      recorder.stop();
      await stopped;
      await sleep(250);

      destination.stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();

      return Array.from(new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer()));
    }

    return {
      video: await recordVideoOnly(),
      audio: await recordAudioOnly(),
    };
  });

  await browser.close();

  return {
    video: Buffer.from(media.video),
    audio: Buffer.from(media.audio),
  };
}

function buildMergeFixturePage(videoUrl, audioUrl) {
  const response = {
    videoDetails: {
      title: "Extension Merge Fixture",
    },
    streamingData: {
      adaptiveFormats: [
        {
          qualityLabel: "1080p",
          height: 1080,
          bitrate: 3200000,
          mimeType: 'video/webm; codecs="vp8"',
          url: videoUrl,
        },
        {
          bitrate: 160000,
          mimeType: 'audio/webm; codecs="opus"',
          url: audioUrl,
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
      moviePlayer.getVideoData = () => ({ title: "Extension Merge Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function buildDirectFixturePage(directUrl) {
  const response = {
    videoDetails: {
      title: "Extension Direct Fixture",
    },
    streamingData: {
      formats: [
        {
          qualityLabel: "720p",
          height: 720,
          bitrate: 1800000,
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          url: directUrl,
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
      moviePlayer.getVideoData = () => ({ title: "Extension Direct Fixture" });
      moviePlayer.getWebPlayerContextConfig = () => ({ jsUrl: "/player.js" });
    </script>
  `);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForButtonResult(page, timeoutMs = 45000) {
  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 20000 });

  let snapshot = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await button.evaluate((node) => ({
      text: node.textContent || "",
      title: node.title || "",
      state: node.dataset.state || "",
      jobId: node.dataset.jobId || "",
    }));

    if (snapshot.text === "已保存" || snapshot.text === "下载失败") {
      return snapshot;
    }

    await page.waitForTimeout(250);
  }

  return snapshot;
}

async function waitForDownloadedFile(filename, timeoutMs = 45000) {
  const targetPath = path.join(downloadsPath, filename);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 0) {
        return {
          path: targetPath,
          size: stats.size,
        };
      }
    }

    await sleep(250);
  }

  return null;
}

function listDownloadedFiles() {
  if (!fs.existsSync(downloadsPath)) {
    return new Map();
  }

  return new Map(
    fs.readdirSync(downloadsPath)
      .filter((name) => !name.endsWith(".crdownload"))
      .map((name) => {
        const filePath = path.join(downloadsPath, name);
        const stats = fs.statSync(filePath);
        return [name, {
          path: filePath,
          size: stats.size,
        }];
      }),
  );
}

async function waitForNewDownloadedFile(previousFiles, timeoutMs = 45000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentFiles = listDownloadedFiles();
    for (const [name, file] of currentFiles.entries()) {
      if (!previousFiles.has(name) && file.size > 0) {
        return {
          name,
          ...file,
        };
      }
    }

    await sleep(250);
  }

  return null;
}

async function runCase(page, url, options) {
  const previousFiles = listDownloadedFiles();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 20000 });
  await button.click();

  const buttonState = await waitForButtonResult(page);
  if (buttonState?.text !== "已保存") {
    throw new Error(`Expected completion state for ${url}, got ${JSON.stringify(buttonState)}`);
  }

  let downloadedFile = null;
  if (options.expectedFilename) {
    downloadedFile = await waitForDownloadedFile(options.expectedFilename);
  } else {
    downloadedFile = await waitForNewDownloadedFile(previousFiles);
  }

  if (!downloadedFile) {
    throw new Error(`Expected downloaded file for ${url}`);
  }

  if (options.expectedSize && downloadedFile.size !== options.expectedSize) {
    throw new Error(`Expected file size ${options.expectedSize} for ${url}, got ${downloadedFile.size}`);
  }

  if (options.minSize && downloadedFile.size < options.minSize) {
    throw new Error(`Expected file size >= ${options.minSize} for ${url}, got ${downloadedFile.size}`);
  }

  return {
    url,
    button: buttonState,
    downloadedFile,
  };
}

async function main() {
  const media = await generateWebmFixtureMedia();
  const directMedia = Buffer.alloc(96 * 1024, 7);

  const mergeTargetUrl = "https://www.youtube.com/shorts/extension-merge-fixture";
  const directTargetUrl = "https://www.youtube.com/shorts/extension-direct-fixture";
  const directMediaUrl = `data:video/mp4;base64,${directMedia.toString("base64")}`;
  const mergeVideoUrl = `data:video/webm;base64,${media.video.toString("base64")}`;
  const mergeAudioUrl = `data:audio/webm;base64,${media.audio.toString("base64")}`;
  const mergeFixturePage = buildMergeFixturePage(mergeVideoUrl, mergeAudioUrl);
  const directFixturePage = buildDirectFixturePage(directMediaUrl);

  const routeHits = {
    mergePage: 0,
    directPage: 0,
    playerJs: 0,
  };

  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(downloadsPath, { recursive: true, force: true });
  fs.mkdirSync(downloadsPath, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    acceptDownloads: true,
    downloadsPath,
    headless: false,
    executablePath,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: {
      width: 1366,
      height: 900,
    },
  });

  await context.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url === mergeTargetUrl) {
      routeHits.mergePage += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: mergeFixturePage,
      });
      return;
    }

    if (url === directTargetUrl) {
      routeHits.directPage += 1;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: directFixturePage,
      });
      return;
    }

    if (url === "https://www.youtube.com/player.js") {
      routeHits.playerJs += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: "console.log('fixture player loaded');",
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "not found",
    });
  });

  const page = context.pages()[0] || await context.newPage();
  const results = [
    await runCase(page, directTargetUrl, {
      expectedSize: directMedia.length,
    }),
    await runCase(page, mergeTargetUrl, {
      minSize: media.video.length + 1,
    }),
  ];

  if (routeHits.mergePage !== 1 || routeHits.directPage !== 1) {
    throw new Error(`Expected both fixture pages to load exactly once, got ${JSON.stringify(routeHits)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    executablePath,
    routeHits,
    results,
    mergeVideoBytes: media.video.length,
    mergeAudioBytes: media.audio.length,
    directBytes: directMedia.length,
  }, null, 2));

  await context.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

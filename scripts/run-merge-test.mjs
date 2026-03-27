import { chromium } from "playwright";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("../extension", import.meta.url));

function contentTypeFor(filePath) {
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".wasm")) {
    return "application/wasm";
  }

  return "application/octet-stream";
}

async function createServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const requestUrl = request.url || "/";
      if (requestUrl === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>merge-test</body></html>");
        return;
      }

      if (!requestUrl.startsWith("/extension/")) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }

      const relativePath = decodeURIComponent(requestUrl.replace(/^\/extension\//, ""));
      const filePath = path.join(extensionDir, relativePath);

      if (!filePath.startsWith(extensionDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }

      response.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "cache-control": "no-store",
      });
      fs.createReadStream(filePath).pipe(response);
    });

    server.listen(0, "127.0.0.1", () => resolve(server));
  });
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
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 120000 });

  const result = await page.evaluate(async () => {
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

      return new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
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

      return new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
    }

    const { buildMergePlan, mergeMediaFiles } = await import("/extension/lib/merge-media.js");
    const videoData = await recordVideoOnly();
    const audioData = await recordAudioOnly();
    const videoSize = videoData.byteLength;
    const audioSize = audioData.byteLength;
    const progressEvents = [];
    const plan = buildMergePlan({
      video: {
        container: "webm",
        mimeType: 'video/webm; codecs="vp8"',
      },
      audio: {
        container: "webm",
        mimeType: 'audio/webm; codecs="opus"',
      },
      preferredOutputExt: "webm",
    });

    const mergedBlob = await mergeMediaFiles({
      videoData,
      videoExt: "webm",
      audioData,
      audioExt: "webm",
      outputName: "merged.webm",
      plan,
      onProgress: (event) => {
        progressEvents.push({
          phase: event.phase,
          percent: event.percent ?? null,
          text: event.text,
        });
      },
    });

    const mergedBytes = new Uint8Array(await mergedBlob.arrayBuffer());
    return {
      ok: true,
      videoSize,
      audioSize,
      mergedSize: mergedBytes.length,
      header: Array.from(mergedBytes.slice(0, 4)),
      progressEvents,
    };
  });

  const webmHeader = [0x1a, 0x45, 0xdf, 0xa3];
  if (!result.ok) {
    throw new Error("Merge test did not complete");
  }

  if (result.videoSize <= 0 || result.audioSize <= 0) {
    throw new Error(`Expected non-empty media inputs, got video=${result.videoSize}, audio=${result.audioSize}`);
  }

  if (result.mergedSize <= result.videoSize) {
    throw new Error(`Expected merged output to be larger than video input, got merged=${result.mergedSize}, video=${result.videoSize}`);
  }

  if (JSON.stringify(result.header) !== JSON.stringify(webmHeader)) {
    throw new Error(`Expected WebM header ${JSON.stringify(webmHeader)}, got ${JSON.stringify(result.header)}`);
  }

  if (!result.progressEvents.some((event) => event.phase === "merge")) {
    throw new Error("Expected merge progress events to be emitted");
  }

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

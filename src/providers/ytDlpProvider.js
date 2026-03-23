import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu")) {
      if (parsed.pathname.startsWith("/shorts/")) {
        return parsed.pathname.split("/")[2] || "";
      }
      return parsed.searchParams.get("v") || "";
    }
  } catch {
    return "";
  }
  return "";
}

function buildArgs(inputUrl, config) {
  const args = [
    "-J",
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "-f",
    config.ytDlpFormat,
  ];

  if (config.ytDlpProxy) {
    args.push("--proxy", config.ytDlpProxy);
  }

  if (config.ytDlpCookiesFile) {
    args.push("--cookies", config.ytDlpCookiesFile);
  }

  if (config.ytDlpCookiesFromBrowser) {
    args.push("--cookies-from-browser", config.ytDlpCookiesFromBrowser);
  }

  args.push(inputUrl);
  return args;
}

function rankFormat(format) {
  const height = Number(format.height || 0);
  const hasAudio = Boolean(format.acodec && format.acodec !== "none");
  const hasVideo = Boolean(format.vcodec && format.vcodec !== "none");

  if (hasAudio && hasVideo) {
    return 10_000 + height;
  }

  if (hasVideo) {
    return 5_000 + height;
  }

  if (hasAudio) {
    return 1_000;
  }

  return 0;
}

function simplifyFormat(format) {
  return {
    formatId: format.format_id,
    ext: format.ext,
    resolution: format.resolution || "",
    formatNote: format.format_note || "",
    acodec: format.acodec,
    vcodec: format.vcodec,
    url: format.url || "",
    protocol: format.protocol || "",
  };
}

export async function resolveWithYtDlp(inputUrl, config) {
  const args = buildArgs(inputUrl, config);
  const { stdout, stderr } = await execFileAsync(config.ytDlpBinary, args, {
    timeout: config.requestTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });

  const payload = JSON.parse(stdout || "null");
  if (!payload) {
    throw new Error(stderr || "yt-dlp returned no JSON payload");
  }

  const formats = Array.isArray(payload.formats) ? payload.formats : [];
  const directFormats = formats
    .filter((format) => format.url)
    .sort((left, right) => rankFormat(right) - rankFormat(left));

  const best = directFormats[0];
  if (!best?.url) {
    throw new Error("yt-dlp did not expose a direct media URL for this video");
  }

  return {
    provider: "yt-dlp",
    status: "ok",
    sourceUrl: inputUrl,
    videoId: payload.id || extractVideoId(inputUrl),
    title: payload.title || "YouTube Video",
    pageUrl: payload.webpage_url || inputUrl,
    directUrl: best.url,
    mimeType: best.ext ? `video/${best.ext}` : "",
    selectedFormat: simplifyFormat(best),
    availableFormats: directFormats.slice(0, 8).map(simplifyFormat),
    diagnostics: {
      extractor: "yt-dlp",
      note: "If this fails in production, provide browser cookies or a cleaner egress IP.",
    },
  };
}


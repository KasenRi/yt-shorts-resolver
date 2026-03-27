import { FFmpeg } from "../vendor/ffmpeg/index.js";

const CORE_JS_PATH = "vendor/ffmpeg/ffmpeg-core.js";
const CORE_WASM_PATH = "vendor/ffmpeg/ffmpeg-core.wasm";
const MAX_SINGLE_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 384 * 1024 * 1024;
const FETCH_IDLE_TIMEOUT_MS = 30000;
const TRACKED_DOWNLOAD_OBJECT_URL_MAX_AGE_MS = 30 * 60 * 1000;
const WEBM_VIDEO_CODEC_FAMILIES = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODEC_FAMILIES = new Set(["opus", "vorbis"]);
const MP4_VIDEO_CODEC_FAMILIES = new Set(["h264", "hevc", "av1", "mpeg4"]);
const MP4_AUDIO_CODEC_FAMILIES = new Set(["aac", "mp3"]);

const ffmpeg = new FFmpeg();
let ffmpegLoadPromise = null;
let mergeQueue = Promise.resolve();

function assetUrl(pathFromRoot) {
  if (globalThis.chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(pathFromRoot);
  }

  return new URL(`../${pathFromRoot}`, import.meta.url).toString();
}

function report(onProgress, event) {
  if (typeof onProgress === "function") {
    onProgress(event);
  }
}

function mimeTypeForExt(ext) {
  if (ext === "webm") {
    return "video/webm";
  }

  return "video/mp4";
}

function joinChunks(chunks, totalBytes) {
  const output = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function normalizeContentLength(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function formatBytes(bytes) {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let value = numeric;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const precision = index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function codecTokensFromMimeType(mimeType) {
  const match = String(mimeType || "").match(/codecs\s*=\s*"?([^";]+)"?/i);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function detectVideoCodecFamily(mimeType) {
  for (const token of codecTokensFromMimeType(mimeType)) {
    if (/^(avc1|avc3|h264)/.test(token)) {
      return "h264";
    }

    if (/^(hev1|hvc1|hevc)/.test(token)) {
      return "hevc";
    }

    if (/^(av01|av1)/.test(token)) {
      return "av1";
    }

    if (/^(vp09|vp9)/.test(token)) {
      return "vp9";
    }

    if (/^(vp08|vp8)/.test(token)) {
      return "vp8";
    }

    if (/^mp4v/.test(token)) {
      return "mpeg4";
    }
  }

  return "";
}

function detectAudioCodecFamily(mimeType) {
  for (const token of codecTokensFromMimeType(mimeType)) {
    if (/^(mp4a|aac)/.test(token)) {
      return "aac";
    }

    if (/^opus/.test(token)) {
      return "opus";
    }

    if (/vorbis/.test(token)) {
      return "vorbis";
    }

    if (/^(mp3|mpga)/.test(token)) {
      return "mp3";
    }
  }

  return "";
}

function preferredOutputExtForVideo(stream) {
  const codecFamily = detectVideoCodecFamily(stream?.mimeType);
  if (WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily) && !MP4_VIDEO_CODEC_FAMILIES.has(codecFamily)) {
    return "webm";
  }

  if (MP4_VIDEO_CODEC_FAMILIES.has(codecFamily) && !WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily)) {
    return "mp4";
  }

  return stream?.container === "webm" ? "webm" : "mp4";
}

function isVideoCompatibleWithOutput(stream, outputExt) {
  const codecFamily = detectVideoCodecFamily(stream?.mimeType);
  if (!codecFamily) {
    return stream?.container === outputExt;
  }

  return outputExt === "webm"
    ? WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily)
    : MP4_VIDEO_CODEC_FAMILIES.has(codecFamily);
}

function isAudioCompatibleWithOutput(stream, outputExt) {
  const codecFamily = detectAudioCodecFamily(stream?.mimeType);
  if (!codecFamily) {
    return stream?.container === outputExt;
  }

  return outputExt === "webm"
    ? WEBM_AUDIO_CODEC_FAMILIES.has(codecFamily)
    : MP4_AUDIO_CODEC_FAMILIES.has(codecFamily);
}

function normalizeFilenameExtension(filename, outputExt) {
  const value = String(filename || "youtube-video");
  if (/\.[A-Za-z0-9]+$/.test(value)) {
    return value.replace(/\.[A-Za-z0-9]+$/, `.${outputExt}`);
  }

  return `${value}.${outputExt}`;
}

function outputExtensionFromFilename(filename) {
  const match = String(filename || "").match(/\.([A-Za-z0-9]+)$/);
  const ext = match?.[1]?.toLowerCase() || "";
  return ext === "webm" ? "webm" : ext === "mp4" ? "mp4" : "";
}

function normalizeMergePlan({ audioExt, outputExt, outputName, plan, videoExt }) {
  if (plan?.outputExt) {
    return {
      outputExt: plan.outputExt,
      requiresTranscode: Boolean(plan.requiresTranscode),
      videoCodecMode: plan.videoCodecMode || "copy",
      audioCodecMode: plan.audioCodecMode || "copy",
      audioBitrate: plan.audioBitrate || (plan.outputExt === "mp4" ? "192k" : "160k"),
    };
  }

  const resolvedOutputExt = outputExt
    || outputExtensionFromFilename(outputName)
    || (videoExt === "webm" && audioExt === "webm" ? "webm" : "mp4");

  return {
    outputExt: resolvedOutputExt,
    requiresTranscode: false,
    videoCodecMode: "copy",
    audioCodecMode: "copy",
    audioBitrate: resolvedOutputExt === "mp4" ? "192k" : "160k",
  };
}

function validateExpectedStreamSize(stream, label, maxBytes) {
  const expectedBytes = normalizeContentLength(stream?.contentLength);
  if (expectedBytes > maxBytes) {
    throw new Error(`${label}过大（${formatBytes(expectedBytes)}），超过浏览器内处理上限 ${formatBytes(maxBytes)}`);
  }

  return expectedBytes;
}

function validateExpectedTotalSize(videoBytes, audioBytes) {
  if (videoBytes > 0 && audioBytes > 0 && videoBytes + audioBytes > MAX_TOTAL_INPUT_BYTES) {
    throw new Error(
      `当前音视频合计约 ${formatBytes(videoBytes + audioBytes)}，超过浏览器内合并上限 ${formatBytes(MAX_TOTAL_INPUT_BYTES)}`,
    );
  }
}

export function buildMergePlan({ video, audio, preferredOutputExt }) {
  let outputExt = preferredOutputExt || preferredOutputExtForVideo(video);
  if (!isVideoCompatibleWithOutput(video, outputExt)) {
    outputExt = preferredOutputExtForVideo(video);
  }

  const audioCopy = isAudioCompatibleWithOutput(audio, outputExt);

  return {
    outputExt,
    requiresTranscode: !audioCopy,
    videoCodecMode: "copy",
    audioCodecMode: audioCopy ? "copy" : outputExt === "mp4" ? "aac" : "libopus",
    audioBitrate: outputExt === "mp4" ? "192k" : "160k",
  };
}

async function ensureFFmpeg() {
  if (ffmpeg.loaded) {
    return ffmpeg;
  }

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = ffmpeg.load({
      coreURL: assetUrl(CORE_JS_PATH),
      wasmURL: assetUrl(CORE_WASM_PATH),
    }).catch((error) => {
      ffmpegLoadPromise = null;
      throw error;
    });
  }

  await ffmpegLoadPromise;
  return ffmpeg;
}

function buildMergeArgs(videoName, audioName, outputName, plan) {
  const args = [
    "-i",
    videoName,
    "-i",
    audioName,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    plan.videoCodecMode,
    "-c:a",
    plan.audioCodecMode,
  ];

  if (plan.audioCodecMode !== "copy") {
    args.push("-b:a", plan.audioBitrate);
  }

  args.push("-shortest");

  if (plan.outputExt === "mp4") {
    args.push("-movflags", "+faststart");
  }

  args.push(outputName);
  return args;
}

async function removeFileIfExists(path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // Ignore cleanup failures for missing files.
  }
}

export async function fetchBinaryWithProgress({
  expectedBytes = 0,
  label,
  maxBytes = MAX_SINGLE_STREAM_BYTES,
  onProgress,
  url,
}) {
  if (expectedBytes > maxBytes) {
    throw new Error(`${label}过大（${formatBytes(expectedBytes)}），超过浏览器内处理上限 ${formatBytes(maxBytes)}`);
  }

  const controller = new AbortController();
  let timeoutId = 0;
  const resetTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException(`Timed out while downloading ${label}`, "AbortError"));
    }, FETCH_IDLE_TIMEOUT_MS);
  };

  let response;
  try {
    resetTimeout();
    response = await fetch(url, {
      credentials: "include",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label}超时`);
    }

    throw error;
  }

  if (!response.ok) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw new Error(`${label} request failed with ${response.status}`);
  }

  const totalBytes = normalizeContentLength(response.headers.get("content-length") || expectedBytes);
  if (totalBytes > maxBytes) {
    controller.abort();
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw new Error(`${label}过大（${formatBytes(totalBytes)}），超过浏览器内处理上限 ${formatBytes(maxBytes)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new Error(`${label}过大（${formatBytes(buffer.byteLength)}），超过浏览器内处理上限 ${formatBytes(maxBytes)}`);
      }

      report(onProgress, {
        phase: label,
        percent: 1,
        text: `${label}完成`,
      });
      return buffer;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`${label}超时`);
      }

      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  const chunks = [];
  let loadedBytes = 0;

  try {
    while (true) {
      resetTimeout();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      loadedBytes += chunk.length;
      if (loadedBytes > maxBytes) {
        await reader.cancel();
        controller.abort();
        throw new Error(`${label}过大（>${formatBytes(maxBytes)}），超过浏览器内处理上限`);
      }

      chunks.push(chunk);

      report(onProgress, {
        phase: label,
        percent: totalBytes > 0 ? Math.min(loadedBytes / totalBytes, 0.999) : null,
        text: totalBytes > 0
          ? `${label}${Math.round((loadedBytes / totalBytes) * 100)}%`
          : `${label}中...`,
      });
    }

    report(onProgress, {
      phase: label,
      percent: 1,
      text: `${label}完成`,
    });

    return joinChunks(chunks, loadedBytes);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label}超时`);
    }

    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runMerge({
  audioData,
  audioExt,
  outputExt,
  outputName,
  onProgress,
  plan,
  videoData,
  videoExt,
}) {
  await ensureFFmpeg();
  const resolvedPlan = normalizeMergePlan({
    audioExt,
    outputExt,
    outputName,
    plan,
    videoExt,
  });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const videoName = `video-${stamp}.${videoExt}`;
  const audioName = `audio-${stamp}.${audioExt}`;
  const mergedName = outputName || `merged-${stamp}.${resolvedPlan.outputExt}`;

  const progressHandler = ({ progress }) => {
    const normalizedProgress = Number.isFinite(progress)
      ? Math.max(0, Math.min(progress, 1))
      : null;

    report(onProgress, {
      phase: "merge",
      percent: normalizedProgress,
      text: normalizedProgress !== null
        ? `${resolvedPlan.requiresTranscode ? "转码合并中" : "合并中"}${Math.round(normalizedProgress * 100)}%`
        : resolvedPlan.requiresTranscode ? "转码合并中..." : "合并中...",
    });
  };

  ffmpeg.on("progress", progressHandler);

  try {
    report(onProgress, {
      phase: "merge",
      percent: 0,
      text: "写入临时文件...",
    });

    await ffmpeg.writeFile(videoName, videoData);
    await ffmpeg.writeFile(audioName, audioData);

    report(onProgress, {
      phase: "merge",
      percent: 0,
      text: resolvedPlan.requiresTranscode ? "开始转码合并..." : "开始合并...",
    });

    const exitCode = await ffmpeg.exec(buildMergeArgs(videoName, audioName, mergedName, resolvedPlan));
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}`);
    }

    const mergedData = await ffmpeg.readFile(mergedName);
    const bytes = mergedData instanceof Uint8Array ? mergedData : new Uint8Array(mergedData);

    report(onProgress, {
      phase: "merge",
      percent: 1,
      text: resolvedPlan.requiresTranscode ? "转码合并完成" : "合并完成",
    });

    return new Blob([bytes], {
      type: mimeTypeForExt(resolvedPlan.outputExt),
    });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await removeFileIfExists(videoName);
    await removeFileIfExists(audioName);
    await removeFileIfExists(mergedName);
  }
}

export function mergeMediaFiles(options) {
  const task = mergeQueue.then(
    () => runMerge(options),
    () => runMerge(options),
  );

  mergeQueue = task.catch(() => undefined);
  return task;
}

export async function mergeDownloadedMedia({
  audio,
  filename,
  onProgress,
  outputExt,
  video,
}) {
  const expectedVideoBytes = validateExpectedStreamSize(video, "视频流", MAX_SINGLE_STREAM_BYTES);
  const expectedAudioBytes = validateExpectedStreamSize(audio, "音频流", MAX_SINGLE_STREAM_BYTES);
  validateExpectedTotalSize(expectedVideoBytes, expectedAudioBytes);

  const plan = buildMergePlan({
    video,
    audio,
    preferredOutputExt: outputExt,
  });
  const resolvedFilename = normalizeFilenameExtension(filename, plan.outputExt);

  const videoData = await fetchBinaryWithProgress({
    url: video.url,
    label: "下载视频",
    maxBytes: Math.min(MAX_SINGLE_STREAM_BYTES, MAX_TOTAL_INPUT_BYTES),
    expectedBytes: expectedVideoBytes,
    onProgress,
  });

  const remainingBytes = MAX_TOTAL_INPUT_BYTES - videoData.byteLength;
  if (remainingBytes <= 0) {
    throw new Error(`视频流已占满浏览器内合并预算（${formatBytes(videoData.byteLength)}）`);
  }

  const audioData = await fetchBinaryWithProgress({
    url: audio.url,
    label: "下载音频",
    maxBytes: Math.min(MAX_SINGLE_STREAM_BYTES, remainingBytes),
    expectedBytes: expectedAudioBytes,
    onProgress,
  });

  if (videoData.byteLength + audioData.byteLength > MAX_TOTAL_INPUT_BYTES) {
    throw new Error(
      `当前音视频合计 ${formatBytes(videoData.byteLength + audioData.byteLength)}，超过浏览器内合并上限 ${formatBytes(MAX_TOTAL_INPUT_BYTES)}`,
    );
  }

  const blob = await mergeMediaFiles({
    videoData,
    videoExt: video.ext,
    audioData,
    audioExt: audio.ext,
    outputName: resolvedFilename,
    onProgress,
    plan,
  });

  return {
    blob,
    filename: resolvedFilename,
    outputExt: plan.outputExt,
  };
}

function anchorDownload(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  let revokeDelayMs = 30000;

  try {
    try {
      if (globalThis.chrome?.downloads?.download) {
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url: objectUrl,
              filename: filename || undefined,
              saveAs: false,
              conflictAction: "uniquify",
            },
            (createdDownloadId) => {
              const error = chrome.runtime.lastError;
              if (error || typeof createdDownloadId !== "number") {
                reject(new Error(error?.message || "Unable to save merged file"));
                return;
              }

              resolve(createdDownloadId);
            },
          );
        });

        revokeDelayMs = 0;
        return {
          tracked: true,
          downloadId,
          objectUrl,
        };
      }
    } catch {
      revokeDelayMs = 30000;
    }

    anchorDownload(objectUrl, filename);
    return {
      tracked: false,
    };
  } finally {
    if (revokeDelayMs > 0) {
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, revokeDelayMs);
    }
  }
}

export function scheduleObjectUrlCleanup(objectUrl) {
  if (!objectUrl) {
    return;
  }

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, TRACKED_DOWNLOAD_OBJECT_URL_MAX_AGE_MS);
}

export function revokeObjectUrl(objectUrl) {
  if (!objectUrl) {
    return;
  }

  URL.revokeObjectURL(objectUrl);
}

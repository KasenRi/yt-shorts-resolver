(function () {
  window.__YTR_PAGE_BRIDGE_READY = true;

  const EXTENSION_SOURCE = "yt-shorts-resolver-content";
  const PAGE_SOURCE = "yt-shorts-resolver-page";
  const PLAYER_FETCH_TIMEOUT_MS = 8000;
  const NO_DOWNLOADABLE_MEDIA = "No downloadable media streams found";
  const MAX_SINGLE_STREAM_BYTES = 256 * 1024 * 1024;
  const MAX_TOTAL_INPUT_BYTES = 384 * 1024 * 1024;
  const WEBM_VIDEO_CODEC_FAMILIES = new Set(["vp8", "vp9", "av1"]);
  const WEBM_AUDIO_CODEC_FAMILIES = new Set(["opus", "vorbis"]);
  const MP4_VIDEO_CODEC_FAMILIES = new Set(["h264", "hevc", "av1", "mpeg4"]);
  const MP4_AUDIO_CODEC_FAMILIES = new Set(["aac", "mp3"]);
  const playerJsTextCache = new Map();
  const signaturePlanCache = new Map();
  let inlinePlayerResponseCache;

  function isDownloadableUrl(url) {
    return /^https?:/i.test(url || "") || /^data:/i.test(url || "");
  }

  function sanitizeFilenamePart(value) {
    return String(value || "youtube-video")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildFilename(title, ext) {
    const safeTitle = sanitizeFilenamePart(title) || "youtube-video";
    const safeExt = ext || "mp4";
    return `${safeTitle}.${safeExt}`;
  }

  function normalizeContentLength(value) {
    const numeric = Number(value || 0);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
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

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractBalanced(text, openIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = openIndex; index < text.length; index += 1) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === openChar) {
        depth += 1;
      } else if (char === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(openIndex, index + 1);
        }
      }
    }

    return "";
  }

  function extractJsonAssignmentFromText(text, marker) {
    const start = text.indexOf(marker);
    if (start === -1) {
      return null;
    }

    const from = start + marker.length;
    const jsonText = extractBalanced(text, from, "{", "}");
    if (!jsonText) {
      return null;
    }

    try {
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  }

  function extractInlineJsonAssignment(marker) {
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || "";
      const parsed = extractJsonAssignmentFromText(text, marker);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  function currentVideoElement() {
    return (
      document.querySelector("ytd-reel-video-renderer[is-active] video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("video")
    );
  }

  function currentVideoId() {
    try {
      const parsed = new URL(location.href);
      if (parsed.pathname.startsWith("/shorts/")) {
        return parsed.pathname.split("/")[2] || "";
      }

      return parsed.searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function playerVideoData() {
    const moviePlayer = document.getElementById("movie_player");
    if (moviePlayer && typeof moviePlayer.getVideoData === "function") {
      try {
        return moviePlayer.getVideoData() || null;
      } catch {
        return null;
      }
    }

    return null;
  }

  function inlinePlayerResponse() {
    if (inlinePlayerResponseCache !== undefined) {
      return inlinePlayerResponseCache;
    }

    inlinePlayerResponseCache = extractInlineJsonAssignment("var ytInitialPlayerResponse = ");
    return inlinePlayerResponseCache;
  }

  function playerResponse() {
    const moviePlayer = document.getElementById("movie_player");
    if (moviePlayer && typeof moviePlayer.getPlayerResponse === "function") {
      const response = moviePlayer.getPlayerResponse();
      if (response) {
        return response;
      }
    }

    return window.ytInitialPlayerResponse || inlinePlayerResponse() || null;
  }

  function resolvePlayerJsUrl(candidate) {
    if (!candidate) {
      return "";
    }

    try {
      return new URL(candidate, location.origin).toString();
    } catch {
      return "";
    }
  }

  function playerJsUrl() {
    const moviePlayer = document.getElementById("movie_player");
    if (moviePlayer && typeof moviePlayer.getWebPlayerContextConfig === "function") {
      try {
        const config = moviePlayer.getWebPlayerContextConfig();
        const resolved = resolvePlayerJsUrl(config?.jsUrl);
        if (resolved) {
          return resolved;
        }
      } catch {
        // Ignore missing player config.
      }
    }

    const ytcfg = window.ytcfg?.data_ || {};
    const configCandidates = [
      ytcfg.PLAYER_JS_URL,
      ytcfg.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.jsUrl,
      ytcfg.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_SHORTS?.jsUrl,
      ytcfg.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.PLAYER_JS_URL,
    ];

    for (const candidate of configCandidates) {
      const resolved = resolvePlayerJsUrl(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return "";
  }

  async function fetchText(url, timeoutMs) {
    if (!url) {
      return "";
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`request failed with ${response.status}`);
      }

      return response.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Timed out while requesting ${url}`);
      }

      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function fetchPlayerJsText(url) {
    const resolvedUrl = resolvePlayerJsUrl(url);
    if (!resolvedUrl) {
      return "";
    }

    if (!playerJsTextCache.has(resolvedUrl)) {
      playerJsTextCache.set(resolvedUrl, fetchText(resolvedUrl, PLAYER_FETCH_TIMEOUT_MS));
    }

    return playerJsTextCache.get(resolvedUrl);
  }

  function extractFunctionSource(text, functionName) {
    const name = escapeRegex(functionName);
    const patterns = [
      new RegExp(`(?:^|[;,])${name}=function\\(([^)]*)\\)\\{`),
      new RegExp(`function ${name}\\(([^)]*)\\)\\{`),
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) {
        continue;
      }

      const bodyStart = match.index + match[0].length - 1;
      const body = extractBalanced(text, bodyStart, "{", "}");
      if (body) {
        return {
          args: match[1],
          body,
        };
      }
    }

    return null;
  }

  function extractObjectSource(text, objectName) {
    const name = escapeRegex(objectName);
    const patterns = [
      new RegExp(`(?:var|let|const) ${name}=\\{`),
      new RegExp(`(?:^|[;,])${name}=\\{`),
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) {
        continue;
      }

      const openIndex = match[0].lastIndexOf("{") + match.index;
      const body = extractBalanced(text, openIndex, "{", "}");
      if (body) {
        return body;
      }
    }

    return "";
  }

  function identifyHelperOperation(body) {
    if (/\.reverse\(\)/.test(body)) {
      return "reverse";
    }

    if (/\.splice\(0,\w+\)/.test(body)) {
      return "splice";
    }

    if (/\.slice\(\w+\)/.test(body)) {
      return "slice";
    }

    if (/\[0\]=\w+\[\w+%\w+\.length\]/.test(body) || /\[0\]=\w+\[\w+\]/.test(body)) {
      return "swap";
    }

    return "";
  }

  function extractHelperOperations(objectBody) {
    if (!objectBody) {
      return new Map();
    }

    const operations = new Map();
    const methodPatterns = [
      /([A-Za-z0-9$]+):function\(([^)]*)\)\{([^}]*)\}/g,
      /([A-Za-z0-9$]+)\(([^)]*)\)\{([^}]*)\}/g,
    ];

    for (const pattern of methodPatterns) {
      let match;
      while ((match = pattern.exec(objectBody)) !== null) {
        const operation = identifyHelperOperation(match[3]);
        if (operation) {
          operations.set(match[1], operation);
        }
      }
    }

    return operations;
  }

  function buildSignaturePlan(playerJs) {
    const namePatterns = [
      /\.sig\|\|([A-Za-z0-9$]+)\(/,
      /["']signature["']\s*,\s*([A-Za-z0-9$]+)\(/,
      /\.set\([^,]+,\s*([A-Za-z0-9$]+)\(/,
      /(?:^|[;,])([A-Za-z0-9$]+)=function\(a\)\{a=a\.split\(""\)/,
      /function\s+([A-Za-z0-9$]+)\(a\)\{a=a\.split\(""\)/,
    ];

    let functionName = "";
    for (const pattern of namePatterns) {
      const match = playerJs.match(pattern);
      if (match?.[1] && match[1] !== "decodeURIComponent") {
        functionName = match[1];
        break;
      }
    }

    if (!functionName) {
      return null;
    }

    const signatureFunction = extractFunctionSource(playerJs, functionName);
    if (!signatureFunction) {
      return null;
    }

    const bodyWithoutBraces = signatureFunction.body.slice(1, -1);
    const helperObjectName = bodyWithoutBraces.match(/([A-Za-z0-9$]+)\.([A-Za-z0-9$]+)\(a(?:,|\))/)?.[1] || "";
    const helperOperations = extractHelperOperations(extractObjectSource(playerJs, helperObjectName));
    const statements = bodyWithoutBraces
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    const operations = [];
    for (const statement of statements) {
      if (
        statement === 'a=a.split("")' ||
        statement === "a=a.split('')" ||
        /^return a\.join\(["']{2}\)$/.test(statement)
      ) {
        continue;
      }

      const helperMatch = statement.match(/(?:a=)?([A-Za-z0-9$]+)\.([A-Za-z0-9$]+)\(a(?:,(\d+))?\)/);
      if (helperMatch) {
        const operation = helperOperations.get(helperMatch[2]);
        if (!operation) {
          return null;
        }

        operations.push({
          type: operation,
          argument: Number(helperMatch[3] || 0),
        });
        continue;
      }

      const reverseMatch = statement.match(/^a\.reverse\(\)$/);
      if (reverseMatch) {
        operations.push({ type: "reverse", argument: 0 });
        continue;
      }

      const spliceMatch = statement.match(/^a\.splice\(0,(\d+)\)$/);
      if (spliceMatch) {
        operations.push({ type: "splice", argument: Number(spliceMatch[1]) });
        continue;
      }

      const sliceMatch = statement.match(/^a=a\.slice\((\d+)\)$/);
      if (sliceMatch) {
        operations.push({ type: "slice", argument: Number(sliceMatch[1]) });
      }
    }

    return operations.length > 0 ? operations : null;
  }

  function applySignaturePlan(signature, operations) {
    const chars = String(signature || "").split("");
    for (const operation of operations) {
      if (operation.type === "reverse") {
        chars.reverse();
        continue;
      }

      if (operation.type === "splice" || operation.type === "slice") {
        chars.splice(0, operation.argument);
        continue;
      }

      if (operation.type === "swap" && chars.length > 0) {
        const index = operation.argument % chars.length;
        const first = chars[0];
        chars[0] = chars[index];
        chars[index] = first;
      }
    }

    return chars.join("");
  }

  async function decipherSignature(signature, preferredPlayerJsUrl) {
    const jsUrl = resolvePlayerJsUrl(preferredPlayerJsUrl) || playerJsUrl();
    if (!jsUrl) {
      return "";
    }

    let operations = signaturePlanCache.get(jsUrl);
    if (operations === undefined) {
      const playerJs = await fetchPlayerJsText(jsUrl);
      operations = buildSignaturePlan(playerJs);
      signaturePlanCache.set(jsUrl, operations || null);
    }

    if (!operations) {
      return "";
    }

    return applySignaturePlan(signature, operations);
  }

  async function resolveCipherUrl(format, preferredPlayerJsUrl) {
    const cipherSource = format?.signatureCipher || format?.cipher;
    if (!cipherSource) {
      return "";
    }

    const params = new URLSearchParams(cipherSource);
    const base = params.get("url");
    if (!base) {
      return "";
    }

    const url = new URL(base);
    const sp = params.get("sp") || "signature";
    const sig = params.get("sig") || params.get("lsig");
    if (sig) {
      url.searchParams.set(sp, sig);
      return url.toString();
    }

    const encryptedSig = params.get("s");
    if (!encryptedSig) {
      return url.toString();
    }

    const deciphered = await decipherSignature(encryptedSig, preferredPlayerJsUrl);
    if (!deciphered) {
      return "";
    }

    url.searchParams.set(sp, deciphered);
    return url.toString();
  }

  function containerForMimeType(mimeType) {
    return /webm/i.test(mimeType || "") ? "webm" : "mp4";
  }

  function extensionForStream({ container, hasVideo }) {
    if (container === "webm") {
      return "webm";
    }

    return hasVideo ? "mp4" : "m4a";
  }

  function preferredOutputExtForVideo(candidate) {
    const codecFamily = detectVideoCodecFamily(candidate?.mimeType);
    if (WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily) && !MP4_VIDEO_CODEC_FAMILIES.has(codecFamily)) {
      return "webm";
    }

    if (MP4_VIDEO_CODEC_FAMILIES.has(codecFamily) && !WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily)) {
      return "mp4";
    }

    return candidate?.container === "webm" ? "webm" : "mp4";
  }

  function isVideoCompatibleWithOutput(candidate, outputExt) {
    const codecFamily = detectVideoCodecFamily(candidate?.mimeType);
    if (!codecFamily) {
      return candidate?.container === outputExt;
    }

    return outputExt === "webm"
      ? WEBM_VIDEO_CODEC_FAMILIES.has(codecFamily)
      : MP4_VIDEO_CODEC_FAMILIES.has(codecFamily);
  }

  function isAudioCompatibleWithOutput(candidate, outputExt) {
    const codecFamily = detectAudioCodecFamily(candidate?.mimeType);
    if (!codecFamily) {
      return candidate?.container === outputExt;
    }

    return outputExt === "webm"
      ? WEBM_AUDIO_CODEC_FAMILIES.has(codecFamily)
      : MP4_AUDIO_CODEC_FAMILIES.has(codecFamily);
  }

  function buildMergePlan(video, audio) {
    let outputExt = preferredOutputExtForVideo(video);
    if (!isVideoCompatibleWithOutput(video, outputExt)) {
      outputExt = video?.container === "webm" ? "webm" : "mp4";
    }

    const requiresTranscode = !isAudioCompatibleWithOutput(audio, outputExt);
    return {
      outputExt,
      requiresTranscode,
    };
  }

  function streamWithinBudget(candidate) {
    return candidate.contentLength === 0 || candidate.contentLength <= MAX_SINGLE_STREAM_BYTES;
  }

  function pairWithinBudget(video, audio) {
    if (!streamWithinBudget(video) || !streamWithinBudget(audio)) {
      return false;
    }

    if (video.contentLength > 0 && audio.contentLength > 0) {
      return video.contentLength + audio.contentLength <= MAX_TOTAL_INPUT_BYTES;
    }

    return true;
  }

  function describeCandidate(format, directUrl) {
    const mimeType = format?.mimeType || "";
    const hasAudio = Boolean(format?.audioQuality || (format?.audioTrack && format.audioTrack.id) || /audio\//.test(mimeType));
    const hasVideo = Boolean(format?.qualityLabel || format?.width || format?.height || /video\//.test(mimeType));
    const container = containerForMimeType(mimeType);

    return {
      directUrl,
      mimeType,
      container,
      ext: extensionForStream({ container, hasVideo }),
      height: Number(format?.height || 0),
      bitrate: Number(format?.bitrate || 0),
      qualityLabel: format?.qualityLabel || "",
      hasAudio,
      hasVideo,
      contentLength: normalizeContentLength(format?.contentLength),
    };
  }

  function compareContainer(left, right) {
    const preference = {
      mp4: 2,
      webm: 1,
    };

    return (preference[right.container] || 0) - (preference[left.container] || 0);
  }

  function compareProgressive(left, right) {
    const containerOrder = compareContainer(left, right);
    if (containerOrder !== 0) {
      return containerOrder;
    }

    if (right.height !== left.height) {
      return right.height - left.height;
    }

    return right.bitrate - left.bitrate;
  }

  function compareVideoOnly(left, right) {
    const containerOrder = compareContainer(left, right);
    if (containerOrder !== 0) {
      return containerOrder;
    }

    if (right.height !== left.height) {
      return right.height - left.height;
    }

    return right.bitrate - left.bitrate;
  }

  function compareAudioOnly(left, right) {
    const containerOrder = compareContainer(left, right);
    if (containerOrder !== 0) {
      return containerOrder;
    }

    return right.bitrate - left.bitrate;
  }

  function compareMergeCandidates(left, right) {
    if (right.video.height !== left.video.height) {
      return right.video.height - left.video.height;
    }

    if (left.plan.requiresTranscode !== right.plan.requiresTranscode) {
      return Number(left.plan.requiresTranscode) - Number(right.plan.requiresTranscode);
    }

    if (right.video.bitrate !== left.video.bitrate) {
      return right.video.bitrate - left.video.bitrate;
    }

    if (right.audio.bitrate !== left.audio.bitrate) {
      return right.audio.bitrate - left.audio.bitrate;
    }

    return compareContainer(left.video, right.video);
  }

  function preferMergePair(progressive, pair) {
    if (!pair) {
      return false;
    }

    if (!progressive) {
      return true;
    }

    if (pair.video.height && pair.video.height > progressive.height) {
      return true;
    }

    if (!pair.video.height && pair.video.bitrate > progressive.bitrate) {
      return true;
    }

    return false;
  }

  async function extractMediaCandidates(response, preferredPlayerJsUrl) {
    const formats = [
      ...(Array.isArray(response?.streamingData?.formats) ? response.streamingData.formats : []),
      ...(Array.isArray(response?.streamingData?.adaptiveFormats) ? response.streamingData.adaptiveFormats : []),
    ];

    const candidates = [];
    for (const format of formats) {
      const directUrl = format.url || await resolveCipherUrl(format, preferredPlayerJsUrl);
      if (!directUrl || !isDownloadableUrl(directUrl)) {
        continue;
      }

      candidates.push(describeCandidate(format, directUrl));
    }

    return candidates;
  }

  function serializeStream(candidate) {
    return {
      url: candidate.directUrl,
      ext: candidate.ext,
      mimeType: candidate.mimeType,
      container: candidate.container,
      qualityLabel: candidate.qualityLabel,
      contentLength: candidate.contentLength,
    };
  }

  function pickBestProgressive(candidates) {
    return candidates
      .filter((candidate) => candidate.hasAudio && candidate.hasVideo)
      .sort(compareProgressive)[0] || null;
  }

  function pickBestMergePair(candidates) {
    const videoOnly = candidates
      .filter((candidate) => candidate.hasVideo && !candidate.hasAudio)
      .sort(compareVideoOnly);
    const audioOnly = candidates
      .filter((candidate) => candidate.hasAudio && !candidate.hasVideo)
      .sort(compareAudioOnly);

    const pairs = [];
    for (const video of videoOnly) {
      for (const audio of audioOnly) {
        if (!pairWithinBudget(video, audio)) {
          continue;
        }

        pairs.push({
          video,
          audio,
          plan: buildMergePlan(video, audio),
        });
      }
    }

    pairs.sort(compareMergeCandidates);
    if (pairs.length === 0) {
      return null;
    }

    return {
      video: pairs[0].video,
      audio: pairs[0].audio,
      outputExt: pairs[0].plan.outputExt,
      requiresTranscode: pairs[0].plan.requiresTranscode,
    };
  }

  function hasOnlyOverBudgetMergePairs(candidates) {
    const videoOnly = candidates.filter((candidate) => candidate.hasVideo && !candidate.hasAudio);
    const audioOnly = candidates.filter((candidate) => candidate.hasAudio && !candidate.hasVideo);
    if (videoOnly.length === 0 || audioOnly.length === 0) {
      return false;
    }

    return videoOnly.every((video) => audioOnly.every((audio) => !pairWithinBudget(video, audio)));
  }

  function directPayload(candidate, title, strategy) {
    const outputExt = candidate.container === "webm" ? "webm" : "mp4";
    return {
      mode: "direct",
      title,
      filename: buildFilename(title, outputExt),
      directUrl: candidate.directUrl,
      strategy,
      hasAudio: candidate.hasAudio,
      hasVideo: candidate.hasVideo,
      qualityLabel: candidate.qualityLabel,
      container: candidate.container,
    };
  }

  function mergePayload(pair, title, strategy) {
    return {
      mode: "merge",
      title,
      filename: buildFilename(title, pair.outputExt),
      outputExt: pair.outputExt,
      requiresTranscode: Boolean(pair.requiresTranscode),
      strategy,
      qualityLabel: pair.video.qualityLabel,
      video: serializeStream(pair.video),
      audio: serializeStream(pair.audio),
    };
  }

  function payloadFromCandidates(candidates, title, strategy) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    const progressive = pickBestProgressive(candidates);
    const mergePair = pickBestMergePair(candidates);

    if (preferMergePair(progressive, mergePair)) {
      return mergePayload(mergePair, title, strategy);
    }

    if (progressive) {
      return directPayload(progressive, title, strategy);
    }

    if (mergePair) {
      return mergePayload(mergePair, title, strategy);
    }

    return null;
  }

  async function resolveFromResponse(response, title, strategy, preferredPlayerJsUrl) {
    if (!response) {
      return null;
    }

    const candidates = await extractMediaCandidates(response, preferredPlayerJsUrl);
    const payload = payloadFromCandidates(candidates, response?.videoDetails?.title || title, strategy);
    if (payload) {
      return payload;
    }

    if (hasOnlyOverBudgetMergePairs(candidates)) {
      throw new Error("当前仅有分离音视频流，但都超出浏览器内合并上限");
    }

    return null;
  }

  function currentDirectVideoSrc() {
    const video = currentVideoElement();
    const currentSrc = video?.currentSrc || "";
    return /^https?:/i.test(currentSrc) ? currentSrc : "";
  }

  function currentSrcPayload(url, title) {
    const container = /mime=video%2Fwebm/i.test(url) ? "webm" : "mp4";
    return {
      mode: "direct",
      title,
      filename: buildFilename(title, container === "webm" ? "webm" : "mp4"),
      directUrl: url,
      strategy: "video-current-src",
      hasAudio: true,
      hasVideo: true,
      qualityLabel: "",
      container,
    };
  }

  async function fetchPlayerResponse(videoId) {
    const cfg = window.ytcfg?.data_ || {};
    const apiKey = cfg.INNERTUBE_API_KEY;
    const context = cfg.INNERTUBE_CONTEXT;

    if (!apiKey || !context || !videoId) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PLAYER_FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": String(cfg.INNERTUBE_CLIENT_NAME || cfg.INNERTUBE_CONTEXT_CLIENT_NAME || "1"),
          "x-youtube-client-version": String(cfg.INNERTUBE_CLIENT_VERSION || cfg.INNERTUBE_CONTEXT_CLIENT_VERSION || ""),
          "x-goog-visitor-id": String(cfg.VISITOR_DATA || ""),
          "x-origin": location.origin,
        },
        body: JSON.stringify({
          context,
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: "HTML5_PREF_WANTS",
            },
          },
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Timed out while requesting youtubei player data");
      }

      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`youtubei player request failed with ${response.status}`);
    }

    return response.json();
  }

  async function fetchWatchPageData(videoId) {
    if (!videoId) {
      return null;
    }

    const html = await fetchText(`/watch?v=${encodeURIComponent(videoId)}`, PLAYER_FETCH_TIMEOUT_MS);
    return {
      response: extractJsonAssignmentFromText(html, "var ytInitialPlayerResponse = "),
      playerJsUrl: resolvePlayerJsUrl(
        html.match(/"jsUrl":"([^"]+base\.js)"/)?.[1] ||
        html.match(/"PLAYER_JS_URL":"([^"]+base\.js)"/)?.[1],
      ),
    };
  }

  function rememberError(errors, error) {
    if (error instanceof Error && error.message) {
      errors.push(error.message);
      return;
    }

    if (typeof error === "string" && error) {
      errors.push(error);
    }
  }

  async function resolveDownload() {
    const response = playerResponse();
    const videoData = playerVideoData();
    const title = response?.videoDetails?.title || videoData?.title || document.title.replace(/\s*-\s*YouTube$/, "") || "YouTube Video";
    const jsUrl = playerJsUrl();
    const errors = [];

    try {
      const fromPlayer = await resolveFromResponse(response, title, "player-response", jsUrl);
      if (fromPlayer) {
        return fromPlayer;
      }
    } catch (error) {
      rememberError(errors, error);
    }

    const videoId = currentVideoId();
    let watchPageData = null;
    try {
      watchPageData = await fetchWatchPageData(videoId);
      const fromWatchPage = await resolveFromResponse(
        watchPageData?.response,
        title,
        "watch-page-html",
        watchPageData?.playerJsUrl || jsUrl,
      );
      if (fromWatchPage) {
        return fromWatchPage;
      }
    } catch (error) {
      rememberError(errors, error);
    }

    let fetchedResponse = null;
    try {
      fetchedResponse = await fetchPlayerResponse(videoId);
      const fromYoutubei = await resolveFromResponse(fetchedResponse, title, "youtubei-player", jsUrl);
      if (fromYoutubei) {
        return fromYoutubei;
      }
    } catch (error) {
      rememberError(errors, error);
    }

    const currentSrc = currentDirectVideoSrc();
    if (currentSrc) {
      return currentSrcPayload(currentSrc, title);
    }

    const playability = (
      fetchedResponse?.playabilityStatus?.reason ||
      watchPageData?.response?.playabilityStatus?.reason ||
      response?.playabilityStatus?.reason ||
      inlinePlayerResponse()?.playabilityStatus?.reason ||
      errors[0] ||
      NO_DOWNLOADABLE_MEDIA
    );

    throw new Error(playability);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== EXTENSION_SOURCE || event.data?.type !== "resolve-request") {
      return;
    }

    const requestId = event.data.requestId;
    try {
      const payload = await resolveDownload();
      window.postMessage(
        {
          source: PAGE_SOURCE,
          requestId,
          ok: true,
          payload,
        },
        "*",
      );
    } catch (error) {
      window.postMessage(
        {
          source: PAGE_SOURCE,
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Unknown resolve error",
        },
        "*",
      );
    }
  });
})();

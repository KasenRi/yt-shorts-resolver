(function () {
  window.__YTR_PAGE_BRIDGE_READY = true;

  const EXTENSION_SOURCE = "yt-shorts-resolver-content";
  const PAGE_SOURCE = "yt-shorts-resolver-page";
  const PLAYER_FETCH_TIMEOUT_MS = 8000;
  const NO_PLAYABLE_FORMATS = "No playable direct format found";
  const playerJsTextCache = new Map();
  const signaturePlanCache = new Map();
  let inlinePlayerResponseCache;

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
        // Ignore missing config.
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
          source: text.slice(match.index, bodyStart + body.length),
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
        continue;
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

      if (operation.type === "splice") {
        chars.splice(0, operation.argument);
        continue;
      }

      if (operation.type === "slice") {
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

  function describeCandidate(format, directUrl) {
    const mimeType = format?.mimeType || "";
    const hasAudio = Boolean(format?.audioQuality || (format?.audioTrack && format.audioTrack.id) || /audio\//.test(mimeType));
    const hasVideo = Boolean(format?.qualityLabel || format?.width || format?.height || /video\//.test(mimeType));
    return {
      directUrl,
      ext: mimeType.includes("webm") ? "webm" : "mp4",
      mimeType,
      height: Number(format?.height || 0),
      bitrate: Number(format?.bitrate || 0),
      qualityLabel: format?.qualityLabel || "",
      hasAudio,
      hasVideo,
    };
  }

  function compareCandidates(left, right) {
    const leftTier = left.hasAudio && left.hasVideo ? 3 : left.hasVideo ? 2 : left.hasAudio ? 1 : 0;
    const rightTier = right.hasAudio && right.hasVideo ? 3 : right.hasVideo ? 2 : right.hasAudio ? 1 : 0;
    if (rightTier !== leftTier) {
      return rightTier - leftTier;
    }

    if (right.height !== left.height) {
      return right.height - left.height;
    }

    return right.bitrate - left.bitrate;
  }

  async function extractMediaCandidates(response, preferredPlayerJsUrl) {
    const formats = [
      ...(Array.isArray(response?.streamingData?.formats) ? response.streamingData.formats : []),
      ...(Array.isArray(response?.streamingData?.adaptiveFormats) ? response.streamingData.adaptiveFormats : []),
    ];

    const candidates = [];
    for (const format of formats) {
      const directUrl = format.url || await resolveCipherUrl(format, preferredPlayerJsUrl);
      if (!directUrl) {
        continue;
      }

      candidates.push(describeCandidate(format, directUrl));
    }

    return candidates.sort(compareCandidates);
  }

  async function waitForCurrentSrc() {
    const video = currentVideoElement();
    if (!video) {
      return "";
    }

    if (video.currentSrc) {
      return video.currentSrc;
    }

    try {
      const playResult = video.play();
      if (playResult && typeof playResult.then === "function") {
        await Promise.race([
          playResult.catch(() => undefined),
          new Promise((resolve) => window.setTimeout(resolve, 1200)),
        ]);
      }
    } catch {
      // Ignore autoplay restrictions.
    }

    if (video.currentSrc) {
      return video.currentSrc;
    }

    await new Promise((resolve) => {
      const onLoaded = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      };

      video.addEventListener("loadedmetadata", onLoaded, { once: true });
      window.setTimeout(() => {
        video.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      }, 2500);
    });

    return video.currentSrc || "";
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
              html5Preference: "HTML5_PREF_WANTS"
            }
          }
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
        html.match(/"PLAYER_JS_URL":"([^"]+base\.js)"/)?.[1]
      ),
    };
  }

  async function resolveFromResponse(response, title, strategy, preferredPlayerJsUrl) {
    if (!response) {
      return null;
    }

    const candidates = await extractMediaCandidates(response, preferredPlayerJsUrl);
    if (candidates.length === 0) {
      return null;
    }

    const best = candidates[0];
    return {
      title: response?.videoDetails?.title || title,
      filename: buildFilename(response?.videoDetails?.title || title, best.ext),
      directUrl: best.directUrl,
      strategy,
      hasAudio: best.hasAudio,
      hasVideo: best.hasVideo,
      qualityLabel: best.qualityLabel,
    };
  }

  async function resolveDownload() {
    const response = playerResponse();
    const videoData = playerVideoData();
    const title = response?.videoDetails?.title || videoData?.title || document.title.replace(/\s*-\s*YouTube$/, "") || "YouTube Video";
    const jsUrl = playerJsUrl();

    const fromPlayer = await resolveFromResponse(response, title, "player-response", jsUrl);
    if (fromPlayer) {
      return fromPlayer;
    }

    const currentSrc = await waitForCurrentSrc();
    if (currentSrc) {
      return {
        title,
        filename: buildFilename(title, "mp4"),
        directUrl: currentSrc,
        strategy: "video-current-src",
        hasAudio: true,
        hasVideo: true,
        qualityLabel: "",
      };
    }

    const videoId = currentVideoId();
    const fromWatchPage = await fetchWatchPageData(videoId);
    const watchResult = await resolveFromResponse(
      fromWatchPage?.response,
      title,
      "watch-page-html",
      fromWatchPage?.playerJsUrl || jsUrl
    );
    if (watchResult) {
      return watchResult;
    }

    const fetchedResponse = await fetchPlayerResponse(videoId);
    const fromYoutubei = await resolveFromResponse(fetchedResponse, title, "youtubei-player", jsUrl);
    if (fromYoutubei) {
      return fromYoutubei;
    }

    const playability = (
      fetchedResponse?.playabilityStatus?.reason ||
      fromWatchPage?.response?.playabilityStatus?.reason ||
      response?.playabilityStatus?.reason ||
      inlinePlayerResponse()?.playabilityStatus?.reason ||
      NO_PLAYABLE_FORMATS
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
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: PAGE_SOURCE,
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Unknown resolve error",
        },
        "*"
      );
    }
  });
})();

(function () {
  window.__YTR_PAGE_BRIDGE_READY = true;

  const EXTENSION_SOURCE = "yt-shorts-resolver-content";
  const PAGE_SOURCE = "yt-shorts-resolver-page";
  const PLAYER_FETCH_TIMEOUT_MS = 8000;
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

  function extractInlineJsonAssignment(marker) {
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script.textContent || "";
      const start = text.indexOf(marker);
      if (start === -1) {
        continue;
      }

      const from = start + marker.length;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let index = from; index < text.length; index += 1) {
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

        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            end = index + 1;
            break;
          }
        }
      }

      const candidate = (end === -1 ? text.slice(from) : text.slice(from, end)).trim();
      if (!candidate) {
        continue;
      }

      try {
        return JSON.parse(candidate);
      } catch {
        continue;
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

  function simplifyCipherUrl(format) {
    if (!format?.signatureCipher) {
      return "";
    }

    const params = new URLSearchParams(format.signatureCipher);
    const base = params.get("url");
    if (!base) {
      return "";
    }

    const sp = params.get("sp");
    const sig = params.get("sig") || params.get("lsig");
    if (!sp || !sig) {
      return base;
    }

    const url = new URL(base);
    url.searchParams.set(sp, sig);
    return url.toString();
  }

  function scoreFormat(format) {
    const hasAudio = Boolean(format?.audioQuality || (format?.audioTrack && format?.audioTrack.id) || (format?.mimeType || "").includes('audio/mp4'));
    const hasVideo = Boolean((format?.mimeType || "").includes("video/") || format?.width || format?.height || format?.qualityLabel);
    const height = Number(format?.height || 0);
    if (hasAudio && hasVideo) {
      return 10000 + height;
    }
    if (hasVideo) {
      return 5000 + height;
    }
    if (hasAudio) {
      return 1000;
    }
    return 0;
  }

  function extractDirectFormats(response) {
    const formats = Array.isArray(response?.streamingData?.formats) ? response.streamingData.formats : [];
    return formats
      .map((format) => {
        const directUrl = format.url || simplifyCipherUrl(format);
        return {
          directUrl,
          ext: format.mimeType?.includes("webm") ? "webm" : "mp4",
          qualityLabel: format.qualityLabel || "",
          mimeType: format.mimeType || "",
          hasAudio: /audio\//.test(format.mimeType || "") || Boolean(format.audioQuality),
          hasVideo: /video\//.test(format.mimeType || "") || Boolean(format.qualityLabel),
          height: Number(format.height || 0),
        };
      })
      .filter((format) => format.directUrl);
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

  async function resolveDownload() {
    const response = playerResponse();
    const videoData = playerVideoData();
    const title = response?.videoDetails?.title || videoData?.title || document.title.replace(/\s*-\s*YouTube$/, "") || "YouTube Video";
    const fromPlayer = extractDirectFormats(response).sort((left, right) => scoreFormat(right) - scoreFormat(left));
    if (fromPlayer.length > 0) {
      const best = fromPlayer[0];
      return {
        title,
        filename: buildFilename(title, best.ext),
        directUrl: best.directUrl,
        strategy: "player-response",
      };
    }

    const currentSrc = await waitForCurrentSrc();
    if (currentSrc) {
      return {
        title,
        filename: buildFilename(title, "mp4"),
        directUrl: currentSrc,
        strategy: "video-current-src",
      };
    }

    const videoId = currentVideoId();
    const fetchedResponse = await fetchPlayerResponse(videoId);
    const fetchedFormats = extractDirectFormats(fetchedResponse).sort((left, right) => scoreFormat(right) - scoreFormat(left));
    if (fetchedFormats.length > 0) {
      const best = fetchedFormats[0];
      return {
        title: fetchedResponse?.videoDetails?.title || title,
        filename: buildFilename(fetchedResponse?.videoDetails?.title || title, best.ext),
        directUrl: best.directUrl,
        strategy: "youtubei-player",
      };
    }

    const playability = fetchedResponse?.playabilityStatus?.reason || response?.playabilityStatus?.reason || inlinePlayerResponse()?.playabilityStatus?.reason || "No playable direct format found";
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

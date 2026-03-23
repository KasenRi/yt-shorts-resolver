const EXTENSION_SOURCE = "yt-shorts-resolver-content";
const PAGE_SOURCE = "yt-shorts-resolver-page";
const BUTTON_CLASS = "ytr-resolve-download-button";
const BRIDGE_ID = "ytr-page-bridge";
const REQUEST_TIMEOUT_MS = 15000;
const NO_PLAYABLE_FORMATS = "No playable direct format found";

function isYouTubeVideoPage() {
  return location.pathname.startsWith("/shorts/") || location.pathname === "/watch";
}

function getCanonicalVideoUrl() {
  const parsed = new URL(location.href);
  if (parsed.pathname.startsWith("/shorts/")) {
    return `${parsed.origin}${parsed.pathname}`;
  }

  const videoId = parsed.searchParams.get("v");
  if (videoId) {
    return `${parsed.origin}/watch?v=${videoId}`;
  }

  return parsed.href;
}

function injectBridge() {
  if (window.__YTR_PAGE_BRIDGE_READY || document.getElementById(BRIDGE_ID) || !document.documentElement) {
    return;
  }

  const script = document.createElement("script");
  script.id = BRIDGE_ID;
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function sanitizeFilenamePart(value) {
  return String(value || "youtube-video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFilename(title, ext) {
  const safeTitle = sanitizeFilenamePart(title) || "youtube-video";
  return `${safeTitle}.${ext || "mp4"}`;
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
  const hasAudio = Boolean(format?.audioQuality || (format?.audioTrack && format?.audioTrack.id) || (format?.mimeType || "").includes("audio/mp4"));
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

function currentVideoElement() {
  return (
    document.querySelector("ytd-reel-video-renderer[is-active] video") ||
    document.querySelector("#movie_player video") ||
    document.querySelector("video")
  );
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

async function resolveFromInlineState() {
  const response = extractInlineJsonAssignment("var ytInitialPlayerResponse = ");
  const title = response?.videoDetails?.title || document.title.replace(/\s*-\s*YouTube$/, "") || "YouTube Video";
  const formats = extractDirectFormats(response).sort((left, right) => scoreFormat(right) - scoreFormat(left));
  if (formats.length > 0) {
    const best = formats[0];
    return {
      title,
      filename: buildFilename(title, best.ext),
      directUrl: best.directUrl,
      strategy: "inline-player-response",
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

  throw new Error(response?.playabilityStatus?.reason || NO_PLAYABLE_FORMATS);
}

function findActionBar() {
  const candidates = [
    ...document.querySelectorAll("ytd-reel-player-overlay-renderer #actions"),
    ...document.querySelectorAll("ytd-menu-renderer #top-level-buttons-computed"),
    ...document.querySelectorAll("#actions-inner"),
  ];

  const visible = candidates.find(isVisibleElement);

  return visible || candidates[0] || null;
}

function isVisibleElement(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function setButtonState(button, state, text) {
  button.dataset.state = state || "";
  button.textContent = text;
}

function waitForResolve(requestId) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out while waiting for page resolver"));
    }, REQUEST_TIMEOUT_MS);

    function onMessage(event) {
      if (event.source !== window || event.data?.source !== PAGE_SOURCE || event.data?.requestId !== requestId) {
        return;
      }

      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      if (event.data?.ok) {
        resolve(event.data.payload);
        return;
      }
      reject(new Error(event.data?.error || "Unknown page resolver error"));
    }

    window.addEventListener("message", onMessage);
  });
}

async function resolveFromPage() {
  const requestId = crypto.randomUUID();
  const resultPromise = waitForResolve(requestId);
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      type: "resolve-request",
      requestId,
      payload: {
        url: getCanonicalVideoUrl(),
      },
    },
    "*"
  );
  return resultPromise;
}

async function resolveDownloadPayload() {
  try {
    return await resolveFromInlineState();
  } catch (inlineError) {
    if (inlineError instanceof Error && inlineError.message && inlineError.message !== NO_PLAYABLE_FORMATS) {
      throw inlineError;
    }
  }

  try {
    return await resolveFromPage();
  } catch (pageError) {
    try {
      return await resolveFromInlineState();
    } catch (inlineError) {
      if (inlineError instanceof Error && inlineError.message && inlineError.message !== NO_PLAYABLE_FORMATS) {
        throw inlineError;
      }
      throw pageError;
    }
  }
}

async function triggerDownload(button) {
  const originalText = button.textContent;
  setButtonState(button, "busy", "解析中...");
  button.title = "";

  try {
    const payload = await resolveDownloadPayload();
    await chrome.runtime.sendMessage({
      type: "download",
      payload: {
        url: payload.directUrl,
        filename: payload.filename,
        openInNewTab: false,
      },
    });
    setButtonState(button, "", "已开始下载");
  } catch (error) {
    console.error("[yt-shorts-resolver]", error);
    button.title = error instanceof Error ? error.message : "Unknown resolver error";
    setButtonState(button, "error", "解析失败");
  } finally {
    window.setTimeout(() => {
      button.title = "";
      setButtonState(button, "", originalText);
    }, 2200);
  }
}

function injectButton() {
  if (!isYouTubeVideoPage()) {
    return;
  }

  injectBridge();

  const actionBar = findActionBar();
  if (!actionBar) {
    return;
  }

  const existingButton = document.querySelector(`.${BUTTON_CLASS}`);
  if (existingButton) {
    if (existingButton.parentElement !== actionBar && isVisibleElement(actionBar)) {
      actionBar.appendChild(existingButton);
    }
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.textContent = "解析下载";
  button.addEventListener("click", () => {
    void triggerDownload(button);
  });
  actionBar.appendChild(button);
}

function init() {
  if (!document.documentElement) {
    window.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }

  injectButton();

  const observer = new MutationObserver(() => {
    injectButton();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  window.addEventListener("yt-navigate-finish", injectButton);
}

init();

const EXTENSION_SOURCE = "yt-shorts-resolver-content";
const PAGE_SOURCE = "yt-shorts-resolver-page";
const BUTTON_CLASS = "ytr-resolve-download-button";
const BRIDGE_ID = "ytr-page-bridge";
const REQUEST_TIMEOUT_MS = 15000;
const BUTTON_RESET_DELAY_MS = 2200;

let runtimeListenerRegistered = false;
let injectScheduled = false;

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

function isVisibleElement(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
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

function currentButton() {
  return document.querySelector(`.${BUTTON_CLASS}`);
}

function removeCurrentButton() {
  currentButton()?.remove();
}

function setButtonState(button, state, text) {
  button.dataset.state = state || "";
  button.disabled = state === "busy";
  button.textContent = text;
}

function scheduleButtonReset(button, originalText) {
  const previousTimer = Number(button.dataset.resetTimerId || 0);
  if (previousTimer) {
    window.clearTimeout(previousTimer);
  }

  const timeoutId = window.setTimeout(() => {
    button.title = "";
    setButtonState(button, "", originalText);
    delete button.dataset.resetTimerId;
  }, BUTTON_RESET_DELAY_MS);

  button.dataset.resetTimerId = String(timeoutId);
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
  injectBridge();

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
    "*",
  );

  return resultPromise;
}

function handleDownloadStatus(message) {
  if (message?.type !== "download-status") {
    return;
  }

  const button = currentButton();
  if (!button || !message.jobId || button.dataset.jobId !== message.jobId) {
    return;
  }

  const originalText = button.dataset.originalText || "解析下载";

  if (message.phase === "running") {
    button.title = Number.isFinite(message.percent) ? `${Math.round(message.percent * 100)}%` : "";
    setButtonState(button, "busy", message.text || "处理中...");
    return;
  }

  button.dataset.jobId = "";

  if (message.phase === "complete") {
    button.title = "";
    setButtonState(button, "", message.text || "已保存");
    scheduleButtonReset(button, originalText);
    return;
  }

  if (message.phase === "error") {
    button.title = message.error || "";
    setButtonState(button, "error", message.text || "下载失败");
    scheduleButtonReset(button, originalText);
  }
}

function ensureRuntimeListener() {
  if (runtimeListenerRegistered || !chrome.runtime?.onMessage?.addListener) {
    return;
  }

  chrome.runtime.onMessage.addListener((message) => {
    handleDownloadStatus(message);
    return undefined;
  });

  runtimeListenerRegistered = true;
}

async function triggerDownload(button) {
  if (button.dataset.state === "busy") {
    return;
  }

  const originalText = button.dataset.originalText || button.textContent || "解析下载";
  button.dataset.originalText = originalText;

  const previousTimer = Number(button.dataset.resetTimerId || 0);
  if (previousTimer) {
    window.clearTimeout(previousTimer);
    delete button.dataset.resetTimerId;
  }

  button.title = "";
  setButtonState(button, "busy", "解析中...");

  try {
    const request = await resolveFromPage();
    const jobId = crypto.randomUUID();
    button.dataset.jobId = jobId;

    const response = await chrome.runtime.sendMessage({
      type: "start-download",
      payload: {
        jobId,
        request,
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unable to start download");
    }

    if (response.tracking || response.mode === "merge") {
      setButtonState(
        button,
        "busy",
        response.text || (response.mode === "merge" ? "准备合并..." : "开始下载..."),
      );
      return;
    }

    button.dataset.jobId = "";
    button.title = response.error || "";
    setButtonState(button, "", response.mode === "tab-fallback" ? "已在新标签打开" : "已开始下载");
    scheduleButtonReset(button, originalText);
  } catch (error) {
    button.dataset.jobId = "";
    console.error("[yt-shorts-resolver]", error);
    button.title = error instanceof Error ? error.message : "Unknown download error";
    setButtonState(button, "error", "下载失败");
    scheduleButtonReset(button, originalText);
  }
}

function injectButton() {
  if (!isYouTubeVideoPage()) {
    removeCurrentButton();
    return;
  }

  ensureRuntimeListener();
  injectBridge();

  const actionBar = findActionBar();
  if (!actionBar) {
    return;
  }

  const existingButton = currentButton();
  if (existingButton) {
    if (existingButton.parentElement !== actionBar && isVisibleElement(actionBar)) {
      actionBar.appendChild(existingButton);
    }
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.dataset.originalText = "解析下载";
  button.dataset.jobId = "";
  button.textContent = "解析下载";
  button.addEventListener("click", () => {
    void triggerDownload(button);
  });

  actionBar.appendChild(button);
}

function scheduleInjectButton() {
  if (injectScheduled) {
    return;
  }

  injectScheduled = true;
  window.requestAnimationFrame(() => {
    injectScheduled = false;
    injectButton();
  });
}

function init() {
  if (!document.documentElement) {
    window.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }

  scheduleInjectButton();

  const observer = new MutationObserver(() => {
    scheduleInjectButton();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  window.addEventListener("yt-navigate-finish", scheduleInjectButton);
}

init();

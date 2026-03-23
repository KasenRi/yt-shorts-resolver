// ==UserScript==
// @name         YouTube Resolve Download Button
// @namespace    https://github.com/KasenRi/yt-shorts-resolver
// @version      1.0.0
// @description  Inject a resolve/download button next to YouTube share actions and call a local backend.
// @match        https://www.youtube.com/*
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const SERVER_BASE = "http://127.0.0.1:8787";
  const BUTTON_CLASS = "tm-yt-resolve-download";
  const STYLE_ID = "tm-yt-resolve-download-style";

  function isVideoPage() {
    return /^\/(watch|shorts)\//.test(location.pathname) || location.pathname === "/watch";
  }

  function getVideoUrl() {
    const parsed = new URL(location.href);
    if (parsed.pathname.startsWith("/shorts/")) {
      return `https://youtube.com${parsed.pathname}`;
    }
    const videoId = parsed.searchParams.get("v");
    return videoId ? `https://youtube.com/watch?v=${videoId}` : location.href;
  }

  function ensureStyle() {
    if (!document.head) {
      return false;
    }

    if (document.getElementById(STYLE_ID)) {
      return true;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        border: 0;
        border-radius: 999px;
        padding: 0 16px;
        height: 36px;
        background: #111;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
        font-weight: 600;
      }

      .${BUTTON_CLASS}[data-state="loading"] {
        opacity: 0.75;
        cursor: wait;
      }
    `;
    document.head.appendChild(style);
    return true;
  }

  function requestResolve(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${SERVER_BASE}/api/resolve`,
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify({ url }),
        onload: (response) => {
          try {
            const json = JSON.parse(response.responseText);
            if (response.status >= 400 || json.status === "error") {
              reject(new Error(json.message || "resolve failed"));
              return;
            }
            resolve(json);
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("backend request failed")),
      });
    });
  }

  function findActionBar() {
    return (
      document.querySelector("ytd-menu-renderer #top-level-buttons-computed") ||
      document.querySelector("ytd-reel-player-overlay-renderer #actions") ||
      document.querySelector("#actions-inner")
    );
  }

  async function onClick(button) {
    const originalText = button.textContent;
    button.dataset.state = "loading";
    button.textContent = "解析中...";

    try {
      const resolved = await requestResolve(getVideoUrl());
      button.textContent = "打开直链";
      if (typeof GM_openInTab === "function") {
        GM_openInTab(resolved.directUrl, { active: true, insert: true });
      } else {
        window.open(resolved.directUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.error("[yt-resolve-download]", error);
      button.textContent = "解析失败";
      alert(`解析失败: ${error.message}`);
    } finally {
      button.dataset.state = "";
      window.setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    }
  }

  function injectButton() {
    if (!isVideoPage()) {
      return;
    }

    const bar = findActionBar();
    if (!bar || bar.querySelector(`.${BUTTON_CLASS}`)) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "解析下载";
    button.addEventListener("click", () => {
      void onClick(button);
    });
    bar.appendChild(button);
  }

  function init() {
    if (!document.documentElement) {
      window.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }

    if (!ensureStyle()) {
      window.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }

    injectButton();

    const observer = new MutationObserver(() => {
      injectButton();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("yt-navigate-finish", injectButton);
  }

  init();
})();

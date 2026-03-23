chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "download") {
    return undefined;
  }

  const { url, filename, openInNewTab } = message.payload || {};
  if (!url) {
    sendResponse({ ok: false, error: "Missing download URL" });
    return undefined;
  }

  if (openInNewTab) {
    chrome.tabs.create({ url }).then(
      () => sendResponse({ ok: true, mode: "tab" }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  chrome.downloads.download(
    {
      url,
      filename: filename || undefined,
      saveAs: false,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        chrome.tabs.create({ url }).then(
          () => sendResponse({ ok: true, mode: "tab-fallback", error: error.message }),
          (tabError) => sendResponse({ ok: false, error: tabError.message || error.message })
        );
        return;
      }

      sendResponse({ ok: true, mode: "download", downloadId });
    }
  );

  return true;
});


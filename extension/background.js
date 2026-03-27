const OFFSCREEN_DOCUMENT = "offscreen.html";
let offscreenCreationPromise = null;
let offscreenPort = null;
let offscreenReady = false;
let offscreenReadyPromise = null;
let resolveOffscreenReady = null;

const jobsById = new Map();
const trackedDownloadJobsById = new Map();
const pendingDirectStartsById = new Map();
const DIRECT_START_TIMEOUT_MS = 10000;

function formatBytes(bytes) {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = numeric;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const precision = index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function resetOffscreenReadyState() {
  offscreenPort = null;
  offscreenReady = false;
  offscreenReadyPromise = new Promise((resolve) => {
    resolveOffscreenReady = resolve;
  });
}

function markOffscreenReady() {
  offscreenReady = true;
  resolveOffscreenReady?.();
  resolveOffscreenReady = null;
}

async function waitForOffscreenReady() {
  if (offscreenReady) {
    return;
  }

  if (!offscreenReadyPromise) {
    resetOffscreenReadyState();
  }

  let timeoutId = 0;
  try {
    await Promise.race([
      offscreenReadyPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timed out while waiting for offscreen document")), 10000);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function registerJob(job) {
  jobsById.set(job.jobId, {
    ...job,
    bytesReceived: 0,
    totalBytes: 0,
    createdAt: Date.now(),
  });
  return jobsById.get(job.jobId);
}

function clearJob(jobId) {
  const job = jobsById.get(jobId);
  if (!job) {
    return;
  }

  if (typeof job.downloadId === "number") {
    trackedDownloadJobsById.delete(job.downloadId);
  }

  jobsById.delete(jobId);
}

function takePendingDirectStart(jobId) {
  const pending = pendingDirectStartsById.get(jobId);
  if (!pending) {
    return null;
  }

  pendingDirectStartsById.delete(jobId);
  if (pending.timeoutId) {
    clearTimeout(pending.timeoutId);
  }

  return pending;
}

function resolvePendingDirectStart(jobId, response) {
  const pending = takePendingDirectStart(jobId);
  if (!pending) {
    return false;
  }

  pending.resolve(response);
  return true;
}

function relayStatus(payload) {
  const tabId = payload?.tabId;
  if (typeof tabId !== "number") {
    return;
  }

  chrome.tabs.sendMessage(tabId, {
    type: "download-status",
    ...payload,
  }).catch(() => undefined);
}

function notifyJob(jobId, payload) {
  const job = jobsById.get(jobId);
  const tabId = payload?.tabId ?? job?.tabId;
  if (typeof tabId === "number") {
    relayStatus({
      jobId,
      tabId,
      ...payload,
    });
  }

  if (payload?.phase === "complete" || payload?.phase === "error") {
    if (job?.type === "merge" && typeof job.downloadId === "number" && offscreenPort) {
      offscreenPort.postMessage({
        type: "release-object-url",
        payload: {
          downloadId: job.downloadId,
        },
      });
    }
    clearJob(jobId);
  }
}

function attachTrackedDownload(jobId, downloadId, progressVerb) {
  const job = jobsById.get(jobId);
  if (!job || typeof downloadId !== "number") {
    return;
  }

  if (typeof job.downloadId === "number" && job.downloadId !== downloadId) {
    trackedDownloadJobsById.delete(job.downloadId);
  }

  job.downloadId = downloadId;
  job.progressVerb = progressVerb || job.progressVerb || "下载";
  job.bytesReceived = 0;
  job.totalBytes = 0;
  trackedDownloadJobsById.set(downloadId, jobId);
}

function trackedDownloadText(job) {
  const verb = job.progressVerb || "下载";
  if (job.totalBytes > 0 && job.bytesReceived > 0) {
    const percent = Math.max(0, Math.min(job.bytesReceived / job.totalBytes, 1));
    return {
      percent,
      text: `${verb}中${Math.round(percent * 100)}%`,
    };
  }

  if (job.bytesReceived > 0) {
    return {
      percent: null,
      text: `${verb}中${formatBytes(job.bytesReceived)}`,
    };
  }

  return {
    percent: null,
    text: verb === "保存" ? "开始保存..." : "开始下载...",
  };
}

function emitTrackedProgress(jobId) {
  const job = jobsById.get(jobId);
  if (!job) {
    return;
  }

  const { percent, text } = trackedDownloadText(job);
  notifyJob(jobId, {
    phase: "running",
    percent,
    text,
  });
}

async function hasOffscreenDocument() {
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
  });

  return contexts.length > 0;
}

async function recreateOffscreenDocument() {
  if (!offscreenCreationPromise) {
    resetOffscreenReadyState();
    offscreenCreationPromise = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["BLOBS", "WORKERS"],
      justification: "Merge separate YouTube audio and video streams before saving the final file.",
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/single offscreen document/i.test(message)) {
        throw error;
      }
    }).finally(() => {
      offscreenCreationPromise = null;
    });
  }

  await offscreenCreationPromise;
  await waitForOffscreenReady();
}

async function ensureOffscreenDocument() {
  if (offscreenPort && offscreenReady) {
    return;
  }

  const existing = await hasOffscreenDocument();
  if (existing) {
    try {
      await waitForOffscreenReady();
      if (offscreenPort && offscreenReady) {
        return;
      }
    } catch {
      await chrome.offscreen.closeDocument().catch(() => undefined);
    }
  }

  await recreateOffscreenDocument();
}

async function startDirectDownload(payload, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Missing sender tab for direct download");
  }

  const { jobId, request } = payload;
  if (!jobId || !request?.directUrl) {
    throw new Error("Missing direct download payload");
  }

  registerJob({
    jobId,
    type: "direct",
    tabId,
    filename: request.filename || "",
    progressVerb: "下载",
  });

  return new Promise((resolve) => {
    pendingDirectStartsById.set(jobId, {
      resolve,
      directUrl: request.directUrl,
      timeoutId: setTimeout(() => {
        takePendingDirectStart(jobId);
        clearJob(jobId);
        resolve({
          ok: false,
          error: "Timed out while starting browser download",
        });
      }, DIRECT_START_TIMEOUT_MS),
    });

    chrome.downloads.download(
      {
        url: request.directUrl,
        filename: request.filename || undefined,
        saveAs: false,
        conflictAction: "uniquify",
      },
      async (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) {
          takePendingDirectStart(jobId);
          clearJob(jobId);
          chrome.tabs.create({ url: request.directUrl }).then(
            () => resolve({
              ok: true,
              mode: "tab-fallback",
              error: error.message,
            }),
            (tabError) => resolve({
              ok: false,
              error: tabError?.message || error.message || "Unable to start download",
            }),
          );
          return;
        }

        attachTrackedDownload(jobId, downloadId, "下载");
        emitTrackedProgress(jobId);

        chrome.downloads.search({ id: downloadId }).then((items) => {
          const item = items[0];
          const trackedJob = jobsById.get(jobId);
          if (!item || !trackedJob) {
            return;
          }

          trackedJob.bytesReceived = Number(item.bytesReceived || 0);
          trackedJob.totalBytes = Number(item.totalBytes || 0);

          if (item.state === "complete") {
            notifyJob(jobId, {
              phase: "complete",
              text: "已保存",
            });
            return;
          }

          if (item.state === "interrupted") {
            notifyJob(jobId, {
              phase: "error",
              text: "下载失败",
              error: item.error || "Download interrupted",
            });
            return;
          }

          emitTrackedProgress(jobId);
        }).catch(() => undefined);

        resolvePendingDirectStart(jobId, {
          ok: true,
          mode: "direct",
          tracking: true,
          text: "开始下载...",
        });
      },
    );
  });
}

async function startMergeDownload(payload, sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Missing sender tab for merge job");
  }

  registerJob({
    jobId: payload.jobId,
    type: "merge",
    tabId,
    filename: payload.request?.filename || "",
    progressVerb: "保存",
  });

  try {
    await ensureOffscreenDocument();

    if (!offscreenPort) {
      throw new Error("Offscreen document is not connected");
    }

    offscreenPort.postMessage({
      type: "merge-job",
      payload: {
        jobId: payload.jobId,
        request: payload.request,
        tabId,
      },
    });

    return {
      ok: true,
      mode: "merge",
      tracking: true,
      text: "准备合并...",
    };
  } catch (error) {
    clearJob(payload.jobId);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "start-download") {
    return undefined;
  }

  void (async () => {
    const payload = message.payload || {};
    const request = payload.request || {};

    if (request.mode === "merge") {
      sendResponse(await startMergeDownload(payload, sender));
      return;
    }

    if (request.mode === "direct" && request.directUrl) {
      sendResponse(await startDirectDownload(payload, sender));
      return;
    }

    sendResponse({
      ok: false,
      error: "Unsupported download payload",
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown background error",
    });
  });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "offscreen") {
    return;
  }

  offscreenPort = port;
  markOffscreenReady();

  port.onMessage.addListener((message) => {
    if (message?.type !== "merge-status") {
      return;
    }

    const payload = message.payload || {};
    if (typeof payload.downloadId === "number") {
      attachTrackedDownload(payload.jobId, payload.downloadId, payload.progressVerb || "保存");
    }
    notifyJob(payload.jobId, payload);
  });

  port.onDisconnect.addListener(() => {
    if (offscreenPort !== port) {
      return;
    }

    offscreenPort = null;
    offscreenReady = false;
    resolveOffscreenReady = null;

    for (const job of Array.from(jobsById.values())) {
      if (job.type !== "merge") {
        continue;
      }

      notifyJob(job.jobId, {
        phase: "error",
        text: "下载失败",
        error: "Merge worker disconnected",
      });
    }
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  const downloadId = delta?.id;
  if (typeof downloadId !== "number") {
    return;
  }

  const jobId = trackedDownloadJobsById.get(downloadId);
  if (!jobId) {
    return;
  }

  const job = jobsById.get(jobId);
  if (!job) {
    trackedDownloadJobsById.delete(downloadId);
    return;
  }

  if (delta.bytesReceived?.current !== undefined) {
    job.bytesReceived = Number(delta.bytesReceived.current || 0);
  }

  if (delta.totalBytes?.current !== undefined) {
    job.totalBytes = Number(delta.totalBytes.current || 0);
  }

  if (delta.state?.current === "complete") {
    notifyJob(jobId, {
      phase: "complete",
      text: "已保存",
    });
    return;
  }

  if (delta.state?.current === "interrupted") {
    notifyJob(jobId, {
      phase: "error",
      text: "下载失败",
      error: delta.error?.current || "Download interrupted",
    });
    return;
  }

  if (delta.state?.current === "in_progress" || delta.bytesReceived || delta.totalBytes) {
    emitTrackedProgress(jobId);
  }
});

chrome.downloads.onCreated.addListener((item) => {
  if (pendingDirectStartsById.size === 0 || !item) {
    return;
  }

  let matchedEntry = null;
  for (const entry of pendingDirectStartsById.entries()) {
    const [jobId, pending] = entry;
    if (item.finalUrl === pending.directUrl || item.url === pending.directUrl) {
      matchedEntry = [jobId, pending];
      break;
    }
  }

  if (!matchedEntry && item.byExtensionId === chrome.runtime.id && pendingDirectStartsById.size === 1) {
    matchedEntry = pendingDirectStartsById.entries().next().value || null;
  }

  if (!matchedEntry) {
    return;
  }

  const [jobId] = matchedEntry;
  attachTrackedDownload(jobId, item.id, "下载");
  emitTrackedProgress(jobId);
  resolvePendingDirectStart(jobId, {
    ok: true,
    mode: "direct",
    tracking: true,
    text: "开始下载...",
  });
});

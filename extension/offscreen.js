import { downloadBlob, mergeDownloadedMedia, revokeObjectUrl, scheduleObjectUrlCleanup } from "./lib/merge-media.js";

const activeJobs = new Set();
const trackedObjectUrlsByDownloadId = new Map();
const backgroundPort = chrome.runtime.connect({ name: "offscreen" });

function emitStatus(payload) {
  backgroundPort.postMessage({
    type: "merge-status",
    payload,
  });
}

async function handleMergeJob({ jobId, request, tabId }) {
  if (!jobId || activeJobs.has(jobId)) {
    return;
  }

  activeJobs.add(jobId);

  try {
    emitStatus({
      jobId,
      tabId,
      phase: "running",
      text: "准备合并...",
    });

    const { blob, filename } = await mergeDownloadedMedia({
      video: request.video,
      audio: request.audio,
      outputExt: request.outputExt,
      filename: request.filename,
      onProgress: ({ percent, text }) => {
        emitStatus({
          jobId,
          tabId,
          phase: "running",
          percent,
          text,
        });
      },
    });

    const saveResult = await downloadBlob(blob, filename);

    if (saveResult?.tracked && typeof saveResult.downloadId === "number") {
      if (saveResult.objectUrl) {
        trackedObjectUrlsByDownloadId.set(saveResult.downloadId, saveResult.objectUrl);
        scheduleObjectUrlCleanup(saveResult.objectUrl);
      }

      emitStatus({
        jobId,
        tabId,
        phase: "running",
        text: "保存文件...",
        downloadId: saveResult.downloadId,
        progressVerb: "保存",
      });
      return;
    }

    emitStatus({
      jobId,
      tabId,
      phase: "running",
      text: "保存文件...",
    });

    emitStatus({
      jobId,
      tabId,
      phase: "complete",
      text: "已保存",
    });
  } catch (error) {
    emitStatus({
      jobId,
      tabId,
      phase: "error",
      text: "下载失败",
      error: error instanceof Error ? error.message : "Unknown merge error",
    });
  } finally {
    activeJobs.delete(jobId);
  }
}

backgroundPort.onMessage.addListener((message) => {
  if (message?.type === "release-object-url") {
    const downloadId = Number(message.payload?.downloadId);
    const objectUrl = trackedObjectUrlsByDownloadId.get(downloadId);
    if (!Number.isNaN(downloadId) && objectUrl) {
      revokeObjectUrl(objectUrl);
      trackedObjectUrlsByDownloadId.delete(downloadId);
    }
    return undefined;
  }

  if (message?.type !== "merge-job") {
    return undefined;
  }

  void handleMergeJob(message.payload || {});
  return undefined;
});

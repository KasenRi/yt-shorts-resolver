function buildAuthHeaders(config) {
  if (!config.upstreamCobaltAuthHeader) {
    return {};
  }
  return {
    Authorization: config.upstreamCobaltAuthHeader,
  };
}

export async function resolveWithCobalt(inputUrl, config) {
  if (!config.upstreamCobaltBaseUrl) {
    throw new Error("UPSTREAM_COBALT_BASE_URL is not configured");
  }

  const response = await fetch(`${config.upstreamCobaltBaseUrl}/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...buildAuthHeaders(config),
    },
    body: JSON.stringify({
      url: inputUrl,
      videoQuality: "1080",
      youtubeVideoContainer: "mp4",
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.status === "error") {
    const message = payload?.error?.code || `cobalt upstream failed with ${response.status}`;
    throw new Error(message);
  }

  if (!payload.url) {
    throw new Error("cobalt upstream did not return a direct URL");
  }

  return {
    provider: "cobalt",
    status: "ok",
    sourceUrl: inputUrl,
    title: payload.filename || "Resolved Download",
    directUrl: payload.url,
    upstreamStatus: payload.status,
    filename: payload.filename || "",
  };
}


const defaultCorsOrigin = "*";

function normalizeBaseUrl(value) {
  if (!value) {
    return "";
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function getConfig() {
  return {
    port: Number(process.env.PORT || 8787),
    corsOrigin: process.env.CORS_ORIGIN || defaultCorsOrigin,
    provider: process.env.RESOLVER_PROVIDER || "yt-dlp",
    ytDlpBinary: process.env.YTDLP_BINARY || "yt-dlp",
    ytDlpProxy: process.env.YTDLP_PROXY || "",
    ytDlpCookiesFile: process.env.YTDLP_COOKIES_FILE || "",
    ytDlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || "",
    ytDlpFormat: process.env.YTDLP_FORMAT || "b[ext=mp4]/b",
    upstreamCobaltBaseUrl: normalizeBaseUrl(process.env.UPSTREAM_COBALT_BASE_URL || ""),
    upstreamCobaltAuthHeader: process.env.UPSTREAM_COBALT_AUTH_HEADER || "",
    fixtureDownloadUrl: process.env.FIXTURE_DOWNLOAD_URL || "",
    fixtureTitle: process.env.FIXTURE_TITLE || "Fixture Download",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  };
}


import { resolveWithCobalt } from "./providers/cobaltProvider.js";
import { resolveWithFixture } from "./providers/fixtureProvider.js";
import { resolveWithYtDlp } from "./providers/ytDlpProvider.js";

export async function resolveDownload(inputUrl, config) {
  if (!inputUrl) {
    throw new Error("Missing url");
  }

  switch (config.provider) {
    case "cobalt":
      return resolveWithCobalt(inputUrl, config);
    case "fixture":
      return resolveWithFixture(inputUrl, config);
    case "yt-dlp":
    default:
      return resolveWithYtDlp(inputUrl, config);
  }
}


import cors from "cors";
import express from "express";

import { getConfig } from "./config.js";
import { resolveDownload } from "./resolveService.js";

const app = express();
const config = getConfig();

app.use(cors({
  origin: config.corsOrigin === "*" ? true : config.corsOrigin,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    provider: config.provider,
  });
});

app.post("/api/resolve", async (request, response) => {
  const inputUrl = String(request.body?.url || "").trim();
  try {
    const resolved = await resolveDownload(inputUrl, config);
    response.json(resolved);
  } catch (error) {
    response.status(502).json({
      status: "error",
      provider: config.provider,
      sourceUrl: inputUrl,
      message: error instanceof Error ? error.message : "Unknown resolve error",
      hint: "For YouTube bot checks, try YTDLP_COOKIES_FILE, YTDLP_COOKIES_FROM_BROWSER, or a cleaner proxy/IP.",
    });
  }
});

app.get("/api/resolve", async (request, response) => {
  const inputUrl = String(request.query?.url || "").trim();
  try {
    const resolved = await resolveDownload(inputUrl, config);
    response.json(resolved);
  } catch (error) {
    response.status(502).json({
      status: "error",
      provider: config.provider,
      sourceUrl: inputUrl,
      message: error instanceof Error ? error.message : "Unknown resolve error",
      hint: "For YouTube bot checks, try YTDLP_COOKIES_FILE, YTDLP_COOKIES_FROM_BROWSER, or a cleaner proxy/IP.",
    });
  }
});

app.listen(config.port, () => {
  console.log(`yt-shorts-resolver listening on http://127.0.0.1:${config.port}`);
  console.log(`provider=${config.provider}`);
});


import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const targetUrl = process.env.TEST_URL || "https://youtube.com/shorts/I30NoCSaZ2M?si=pA7R2ywBYqKtYpeS";
const userScriptPath = new URL("../tampermonkey/youtube-download.user.js", import.meta.url);

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/bin/google-chrome",
  });
  const page = await browser.newPage();

  await page.route("http://127.0.0.1:8787/api/resolve", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "fixture",
        status: "ok",
        sourceUrl: targetUrl,
        title: "Fixture Download",
        directUrl: "https://www.w3schools.com/html/mov_bbb.mp4",
      }),
    });
  });

  await page.addInitScript({ path: fileURLToPath(userScriptPath) });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(8000);

  const exists = await page.locator("button.tm-yt-resolve-download").count();
  if (!exists) {
    throw new Error("Resolve button was not injected");
  }

  console.log("e2e-ok");
  await browser.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

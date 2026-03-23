import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../extension", import.meta.url));
const userDataDir = fileURLToPath(new URL("../tmp/chrome-extension-profile", import.meta.url));
const targetUrl = process.env.TEST_URL || "https://youtube.com/shorts/I30NoCSaZ2M?si=pA7R2ywBYqKtYpeS";
const executablePath = process.env.CHROME_EXECUTABLE_PATH || chromium.executablePath();

async function main() {
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    viewport: {
      width: 1366,
      height: 900
    }
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(10000);

  const button = page.locator("button.ytr-resolve-download-button");
  await button.waitFor({ timeout: 20000 });

  const visibility = await button.evaluate((node) => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      text: node.textContent,
      parentId: node.parentElement?.id || null,
      display: style.display,
      visibility: style.visibility,
      width: rect.width,
      height: rect.height
    };
  });

  if (visibility.display === "none" || visibility.visibility === "hidden" || visibility.width === 0 || visibility.height === 0) {
    throw new Error(`Injected button is not visible: ${JSON.stringify(visibility)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    executablePath,
    button: visibility
  }, null, 2));

  await context.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

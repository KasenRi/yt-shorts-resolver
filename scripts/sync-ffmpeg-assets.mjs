import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const vendorDir = path.join(repoRoot, "extension", "vendor", "ffmpeg");

const assetGroups = [
  {
    sourceDir: path.join(repoRoot, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm"),
    files: [
      "classes.js",
      "const.js",
      "errors.js",
      "index.js",
      "types.js",
      "utils.js",
      "worker.js",
    ],
  },
  {
    sourceDir: path.join(repoRoot, "node_modules", "@ffmpeg", "core", "dist", "esm"),
    files: [
      "ffmpeg-core.js",
      "ffmpeg-core.wasm",
    ],
  },
];

fs.mkdirSync(vendorDir, { recursive: true });

for (const group of assetGroups) {
  for (const file of group.files) {
    const source = path.join(group.sourceDir, file);
    const target = path.join(vendorDir, file);
    fs.copyFileSync(source, target);
  }
}

console.log(`Synced ffmpeg assets to ${vendorDir}`);

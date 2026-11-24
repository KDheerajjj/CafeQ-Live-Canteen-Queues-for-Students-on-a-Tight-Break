// make-qr.js — one QR per cafe, pointing at report.html?cafe=<id>.
// Writes qr/<cafe-id>.png and a printable qr/posters.html (one A5-ish poster per cafe).
//
// Usage: set CAFEQ_BASE_URL in .env (your HTTPS site, e.g. https://<project>.web.app), then
//        npm run qr
// Uses the local seed/cafes.json, so it needs no Firebase credentials.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const base = (process.env.CAFEQ_BASE_URL || "").replace(/\/+$/, "");
if (!/^https:\/\//.test(base) || base.includes("your-project-id")) {
  console.error("Set CAFEQ_BASE_URL in .env to your deployed HTTPS URL (geolocation needs HTTPS).");
  process.exit(1);
}

const { cafes } = JSON.parse(await readFile(new URL("../seed/cafes.json", import.meta.url), "utf8"));
const outDir = new URL("../qr/", import.meta.url);
await mkdir(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const posters = [];

for (const cafe of cafes) {
  const url = `${base}/report.html?cafe=${encodeURIComponent(cafe.id)}`;
  const opts = { errorCorrectionLevel: "M", margin: 2, width: 800 };
  await QRCode.toFile(fileURLToPath(new URL(`${cafe.id}.png`, outDir)), url, opts);
  const dataUrl = await QRCode.toDataURL(url, opts);
  posters.push(`
  <section class="poster">
    <h1>How busy is ${esc(cafe.name)}?</h1>
    <p class="big">Scan &amp; tap once 🟢 🟡 🔴</p>
    <img src="${dataUrl}" alt="QR code for ${esc(cafe.name)}">
    <p>Help day scholars on a short break pick where to eat.<br>Anonymous · no login · no app install.</p>
    <p class="url">${esc(url)}</p>
  </section>`);
  console.log(`${cafe.id}.png -> ${url}`);
}

await writeFile(
  new URL("posters.html", outDir),
  `<!doctype html><meta charset="utf-8"><title>CafeQ QR posters</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  .poster { page-break-after: always; text-align: center; padding: 32px; }
  h1 { font-size: 30px; margin: 0 0 8px; } .big { font-size: 22px; font-weight: 700; }
  img { width: 70%; max-width: 420px; } .url { font-size: 11px; color: #666; word-break: break-all; }
</style>
${posters.join("\n")}`
);
console.log("Printable posters: qr/posters.html (open in a browser and print).");

// make-icons.js — build the whole PWA icon set from assets/icon-source.png.
//
// The source is the CafeQ tile (orange, rounded) on a dark-brown margin. Outputs
// in public/icons/:
//   icon-192.png, icon-512.png      "any" icons: the full artwork, squared up
//   icon-maskable-512.png           extra dark-brown margin so the tile content sits
//                                   inside Android's 80 % safe-zone circle
//   apple-touch-icon.png (180)      cropped to the orange tile; iOS rounds the corners itself
//   favicon-32.png                  cropped to the tile so it reads at tiny sizes
//
// Usage: npm run icons   (re-run whenever assets/icon-source.png changes, then bump
//        CACHE_VERSION in public/service-worker.js so installed apps pick it up)

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../assets/icon-source.png", import.meta.url));
const OUT = fileURLToPath(new URL("../public/icons/", import.meta.url));
mkdirSync(OUT, { recursive: true });

// Brand colours (sampled from the artwork). Keep in sync with manifest.webmanifest.
const DARK_BROWN = { r: 58, g: 30, b: 18, alpha: 1 }; // #3A1E12 margin / splash background

const meta = await sharp(SRC).metadata();

// 1) Square the artwork by padding the short side with the margin colour.
const side = Math.max(meta.width, meta.height);
const square = await sharp(SRC)
  .flatten({ background: DARK_BROWN })
  .extend({
    top: Math.floor((side - meta.height) / 2),
    bottom: Math.ceil((side - meta.height) / 2),
    left: Math.floor((side - meta.width) / 2),
    right: Math.ceil((side - meta.width) / 2),
    background: DARK_BROWN,
  })
  .png()
  .toBuffer();

// 2) Find the orange tile's bounding box (pixels clearly brighter than the margin).
const { data, info } = await sharp(square).raw().toBuffer({ resolveWithObject: true });
let minX = side, minY = side, maxX = 0, maxY = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] > 120) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
}
const tileSide = Math.max(maxX - minX, maxY - minY) + 1;
const tile = await sharp(square)
  .extract({ left: minX, top: minY, width: Math.min(tileSide, side - minX), height: Math.min(tileSide, side - minY) })
  .png()
  .toBuffer();

const resize = (buf, size) => sharp(buf).resize(size, size, { fit: "cover", kernel: "lanczos3" }).png();

await resize(square, 192).toFile(OUT + "icon-192.png");
await resize(square, 512).toFile(OUT + "icon-512.png");

// Maskable: shrink the artwork to 86 % and pad with margin colour.
const inner = Math.round(512 * 0.86);
const pad = Math.floor((512 - inner) / 2);
await sharp(await resize(square, inner).toBuffer())
  .extend({ top: pad, left: pad, bottom: 512 - inner - pad, right: 512 - inner - pad, background: DARK_BROWN })
  .png()
  .toFile(OUT + "icon-maskable-512.png");

await resize(tile, 180).flatten({ background: DARK_BROWN }).toFile(OUT + "apple-touch-icon.png");
await resize(tile, 32).toFile(OUT + "favicon-32.png");

console.log(`Source ${meta.width}x${meta.height}; tile ${tileSide}px at (${minX},${minY}).`);
if (side < 512) console.warn(`NOTE: source is ${side}px, so the 512px icons are upscaled. Use a >=1024px source for crisp icons.`);
console.log("Wrote icon set to public/icons/");

// make-icons.js — generate PLACEHOLDER PWA icons with no dependencies.
// Draws a coffee cup seen from above (brown tile, cream rim, dark coffee) as PNGs.
// Replace public/icons/*.png with designed icons whenever you like.
//
// Usage: npm run icons

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BROWN = [122, 62, 18];
const CREAM = [246, 236, 220];
const COFFEE = [74, 38, 14];

// CRC32 for PNG chunks.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** @param scale fraction of the tile the cup occupies (smaller for maskable safe zone) */
function icon(size, scale) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const c = size / 2;
  const rim = (size / 2) * scale;
  const coffee = rim * 0.72;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // Handle: a small cream square to the right of the rim.
      const handle = x > c + rim * 0.92 && x < c + rim * 1.3 && Math.abs(y - c) < rim * 0.22 && d > rim;
      const col = d < coffee ? COFFEE : d < rim || handle ? CREAM : BROWN;
      raw.set(col, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), icon(192, 0.62));
writeFileSync(new URL("icon-512.png", out), icon(512, 0.62));
writeFileSync(new URL("icon-maskable-512.png", out), icon(512, 0.5)); // inside the 80% safe zone
console.log("Wrote placeholder icons to public/icons/");

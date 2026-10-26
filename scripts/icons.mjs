// Generate the icon set from the Section 2 geometry. Both emitters below read
// scripts/lib/mark-geometry.mjs's PRIMS and nothing else, so the SVG and every
// PNG size are pixels of the same numbers:
//
//   npm run icons        # regenerates assets/mark.svg + assets/icon-<n>.png
//
// PNG encoding has no new dependency on purpose: it is straight RGBA with a
// filter byte of 0 per row, deflated by node:zlib and wrapped in
// IHDR/IDAT/IEND chunks with a CRC32 implemented here.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { PRIMS, SIZES } from "./lib/mark-geometry.mjs";

/** "#rrggbb" -> { r, g, b } (the fills are fixed by the plan, so strict). */
function hex(color) {
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (!m) throw new Error(`unsupported fill: ${color}`);
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

/** The mark as SVG: one <rect> per prim, straight off the 128 grid. */
export function renderMarkSvg() {
  const rects = PRIMS.map((p) =>
    `  <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"` +
    ` rx="${p.rx}" fill="${p.fill}"/>`
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">`,
    ...rects,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Rounded-rect signed distance at grid point (gx, gy) for one prim.
 * Negative inside, zero on the edge, positive outside.
 */
function signedDistance(gx, gy, prim) {
  const cx = prim.x + prim.w / 2;
  const cy = prim.y + prim.h / 2;
  const dx = Math.abs(gx - cx) - (prim.w / 2 - prim.rx);
  const dy = Math.abs(gy - cy) - (prim.h / 2 - prim.rx);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - prim.rx;
}

/**
 * Rasterise PRIMS at `size` px and wrap it in a PNG. Each pixel is
 * supersampled 4x4 (sample points offset +0.5/SUB), the prim stack painted
 * top-down (bars first because they sit above the tile); every fill is opaque,
 * so the topmost prim containing a sample wins. Alpha is straight, never
 * premultiplied.
 */
export function renderIconPng(size) {
  const SUB = 4;
  const fills = PRIMS.map((p) => hex(p.fill));
  const scale = size / 128;
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const gy = (py + (sy + 0.5) / SUB) / scale;
          const gx = (px + (sx + 0.5) / SUB) / scale;
          // Paint top-down: a later prim (bars) sits above earlier ones
          // (the tile), so the stack is walked from the top first.
          for (let i = PRIMS.length - 1; i >= 0; i--) {
            if (signedDistance(gx, gy, PRIMS[i]) <= 0) {
              r += fills[i].r;
              g += fills[i].g;
              b += fills[i].b;
              covered++;
              break;
            }
          }
        }
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / (SUB * SUB)) * 255);
    }
  }

  // Each scanline gets a filter byte; 0 = none, the only filter we emit.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive per row (we always write 0)
  ihdr[12] = 0; // interlace: none

  const SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** CRC table for the standard PNG CRC-32. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type + data, CRC over the type and data. */
function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([
    Buffer.from(type, "latin1"),
    data,
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, crc]);
}

/** Write mark.svg and one icon-<size>.png per SIZES entry into `dir`. */
export async function writeAssets(dir) {
  await mkdir(dir, { recursive: true });
  const outputs = [
    ["mark.svg", renderMarkSvg()],
    ...SIZES.map((s) => [`icon-${s}.png`, renderIconPng(s)]),
  ];
  const written = [];
  for (const [file, data] of outputs) {
    const p = path.join(dir, file);
    await writeFile(p, data);
    written.push(p);
  }
  return written;
}

// Only run when invoked directly, so importing renderIconPng in a test does
// not regenerate anything. `import.meta.main` is not available on Node 22.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const dir = "assets";
  for (const p of await writeAssets(dir)) {
    console.log(p);
  }
}

// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark home-cinema gradient,
// a projector body with its large lens on the left, and a beam of light onto
// a screen on the right. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const DARK = [8, 9, 14];
const NIGHT = [26, 24, 44];
const BODY = [32, 33, 40];
const BODY_LIGHT = [70, 72, 84];
const PANEL = [16, 17, 22];
const LENS_RING = [110, 112, 124];
const LENS_GLASS = [24, 40, 70];
const BEAM = [255, 236, 190];
const SCREEN = [232, 232, 238];
const SCREEN_EDGE = [40, 40, 48];
const LED = [70, 200, 120];

const PROJ = { cx: 210, cy: 330, w: 160, h: 62, r: 16 };
const LENS = { x: 300, y: 330, r: 44 };
const SCR = { cx: 610, cy: 210, w: 150, h: 92 };

function pixel(x, y) {
  let color = mix(DARK, NIGHT, (x / WIDTH) * 0.5 + (1 - y / HEIGHT) * 0.5);
  // The screen, lit by the beam.
  const screen = roundRect(x, y, SCR.cx, SCR.cy, SCR.w + 6, SCR.h + 6, 3);
  color = mix(color, SCREEN_EDGE, inside(screen));
  const lit = roundRect(x, y, SCR.cx, SCR.cy, SCR.w, SCR.h, 2);
  const glow = 1 - Math.hypot((x - SCR.cx) / (SCR.w * 1.6), (y - SCR.cy) / (SCR.h * 1.6));
  color = mix(color, mix(SCREEN, BEAM, 0.35 + glow * 0.3), inside(lit));
  // The beam: a cone from the lens to the screen corners, fading with distance.
  if (x > LENS.x && x < SCR.cx - SCR.w) {
    const t = (x - LENS.x) / (SCR.cx - SCR.w - LENS.x);
    const top = LENS.y - 20 + (SCR.cy - SCR.h - (LENS.y - 20)) * t;
    const bottom = LENS.y + 20 + (SCR.cy + SCR.h - (LENS.y + 20)) * t;
    if (y > top && y < bottom) {
      const edge = Math.min(y - top, bottom - y) / 30;
      color = mix(color, BEAM, Math.min(1, edge) * (0.16 + 0.1 * (1 - t)));
    }
  }
  // Floor shadow under the projector.
  const shadow = Math.hypot((x - PROJ.cx) / 200, (y - 410) / 14);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.8);
  // The body, lit from above, with a vent panel.
  const body = roundRect(x, y, PROJ.cx, PROJ.cy, PROJ.w, PROJ.h, PROJ.r);
  color = mix(color, mix(BODY_LIGHT, BODY, (y - PROJ.cy + PROJ.h) / (2 * PROJ.h)), inside(body));
  for (let i = 0; i < 7; i += 1) {
    color = mix(color, PANEL, inside(roundRect(x, y, 110 + i * 20, 330, 5, 30, 3)));
  }
  color = mix(color, LED, inside(Math.hypot(x - 90, y - 288) - 4));
  // The lens: a ring, the glass, a reflection.
  const d = Math.hypot(x - LENS.x, y - LENS.y);
  color = mix(color, PANEL, inside(d - LENS.r - 8));
  color = mix(color, LENS_RING, inside(d - LENS.r));
  color = mix(color, mix(LENS_GLASS, BEAM, Math.max(0, 1 - d / 30) * 0.9), inside(d - LENS.r + 10));
  color = mix(
    color,
    [200, 220, 255],
    inside(Math.hypot(x - LENS.x + 12, y - LENS.y + 14) - 6) * 0.7,
  );
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

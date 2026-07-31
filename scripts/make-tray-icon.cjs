#!/usr/bin/env node
// Generates the menu-bar tray icon: a "G" for GVoice with three soundwave bars.
// Output is a macOS *template* image (black shape + alpha) so macOS tints it to
// match the menu bar and it stays subtle in both light and dark modes. The
// `Template` filename suffix makes Electron flag it as a template automatically.
//
// Writes public/trayTemplate.png (@1x) and public/trayTemplate@2x.png (@2x).
// Pure Node — no image deps — so it's reproducible in any checkout.
//
// Eyeball it while tweaking:  node scripts/make-tray-icon.cjs --preview
//
// The icon is WIDER than it is tall. The menu bar constrains height only, and a
// legible G plus three bars does not fit in a 22×22 square — squeezed into one,
// the bars land at sub-pixel widths and the G closes up into an O.
//
// Every measurement is a fraction of the HEIGHT, and the shapes are signed
// distance fields rather than filled spans, so one set of numbers renders
// cleanly at 22px, at 44px, and blown up in the preview.

const zlib = require("node:zlib");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const H = 22;            // menu-bar height in points; @2x doubles it
const ASPECT = 32 / 22;  // room for the G and the bars side by side

// The soundwave: three bars right of the G, tallest in the middle.
const BAR_HEIGHT_FRACTIONS = [0.46, 0.86, 0.62];

const DEG = Math.PI / 180;
// Where the ring is cut away for the G's mouth, clockwise from 3 o'clock
// (screen coords, so positive angles go down). The upper terminal stops at -58°
// and the lower ring resumes at +15°, just under the crossbar. Much narrower
// than this and the letter reads as an O with a nick in it.
const MOUTH_FROM = -58 * DEG;
const MOUTH_TO = 15 * DEG;

/** Render the G + soundwave into an RGBA buffer at `w`×`h`. */
function renderIcon(w, h) {
  const px = Buffer.alloc(w * h * 4, 0); // transparent
  // Coverage from a signed distance: `d` is how far outside the shape a sample
  // sits, so a 1px band around the edge is the anti-aliasing.
  const cov = (d) => Math.max(0, Math.min(1, 0.5 - d));
  const set = (x, y, a) => {
    if (a <= 0) return;
    const i = (y * w + x) * 4;
    px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; // black (template tint ignores RGB)
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * a)); // keep strongest alpha
  };
  // Distance to a horizontal capsule (a bar with rounded caps).
  const capsuleH = (sx, sy, x0, x1, cy, r) =>
    Math.hypot(Math.max(0, Math.max(x0 - sx, sx - x1)), sy - cy) - r;
  // Distance to a vertical one.
  const capsuleV = (sx, sy, cx, y0, y1, r) =>
    Math.hypot(sx - cx, Math.max(0, Math.max(y0 - sy, sy - y1))) - r;

  // Stroke weight, shared by the ring and its crossbar so the G reads as one
  // pen. Below ~3px at @1x the letter turns to mush in the menu bar.
  const t = h * 0.155;
  const R = h * 0.332;   // ring radius, measured to the centre of the stroke
  const cy = h / 2;
  const cx = h * 0.09 + R + t / 2;

  // Bars, right-aligned, with a clear gap after the G's mouth. Their widths and
  // left edge are snapped to whole pixels: at 22px a bar is only 2px wide, and
  // landing on a half-pixel smears it into a 3px grey blur. The circle can't be
  // snapped this way, but straight vertical edges can, so they are.
  const n = BAR_HEIGHT_FRACTIONS.length;
  const barW = Math.max(2, Math.round(h * 0.091));
  const barGap = Math.max(1, Math.round(h * 0.045));
  const barR = barW / 2;
  const barsRight = w - Math.round(h * 0.068);
  const barsLeft = Math.round(barsRight - (n * barW + (n - 1) * barGap));
  const maxBarH = h * 0.80;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x + 0.5, sy = y + 0.5;   // sample the pixel centre
      let d = Infinity;                    // distance to the nearest shape

      // --- G: a ring with a wedge cut out, plus the crossbar in the gap ---
      const dx = sx - cx, dy = sy - cy;
      const angle = Math.atan2(dy, dx);
      if (angle <= MOUTH_FROM || angle >= MOUTH_TO) {
        d = Math.abs(Math.hypot(dx, dy) - R) - t / 2;
      } else {
        // Round both terminals so the mouth doesn't end on a sheared edge.
        for (const a of [MOUTH_FROM, MOUTH_TO]) {
          const ex = cx + R * Math.cos(a), ey = cy + R * Math.sin(a);
          d = Math.min(d, Math.hypot(sx - ex, sy - ey) - t / 2);
        }
      }
      // The crossbar — the stroke that makes it a G and not a C. Runs from just
      // right of centre out to the ring's outer edge.
      d = Math.min(d, capsuleH(sx, sy, cx + h * 0.04, cx + R, cy, t / 2));

      // --- Soundwave ---
      for (let b = 0; b < n; b++) {
        const bcx = barsLeft + b * (barW + barGap) + barR;
        const bh = maxBarH * BAR_HEIGHT_FRACTIONS[b];
        d = Math.min(d, capsuleV(sx, sy, bcx, cy - bh / 2 + barR, cy + bh / 2 - barR, barR));
      }

      set(x, y, cov(d));
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --preview writes a blow-up to the OS temp dir so the shape can be judged at a
// size where the anti-aliasing is visible. Deliberately not in public/ — that
// folder is bundled into the app, and a 320px preview has no business shipping.
const preview = process.argv.includes("--preview");
const out = preview ? tmpdir() : join(__dirname, "..", "public");
const targets = preview
  ? [["gvoice-tray-preview.png", H * 10]]
  : [["trayTemplate.png", H], ["trayTemplate@2x.png", H * 2]];
for (const [name, h] of targets) {
  const w = Math.round(h * ASPECT);
  writeFileSync(join(out, name), encodePng(w, h, renderIcon(w, h)));
  console.log("wrote", join(out, name), `(${w}x${h})`);
}

// Pure-JS screenshot pipeline: PNG decode -> downscale -> optional element labels -> JPEG.
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

export function decodePng(buf) {
  // screencap output sometimes has CRLF corruption on very old adb/Windows; exec-out avoids it.
  const i = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (i < 0) throw new Error("screencap did not return a PNG (screen may be protected/secure, or device locked in a secure app)");
  const png = PNG.sync.read(i ? buf.subarray(i) : buf);
  return { width: png.width, height: png.height, data: png.data };
}

// Area-average downscale (RGBA).
export function resize(img, scale) {
  if (scale >= 1) return img;
  const W = Math.max(1, Math.round(img.width * scale)), H = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(W * H * 4);
  const sx = img.width / W, sy = img.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) { r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++; }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

// 3x5 digit glyphs.
const GLYPH = {
  0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"], 2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"], 4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"], 8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
};
const PALETTE = [[230, 25, 75], [0, 130, 200], [245, 130, 48], [60, 180, 75], [145, 30, 180], [0, 128, 128]];

function px(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
}
function rect(img, x1, y1, x2, y2, c, t = 2) {
  for (let k = 0; k < t; k++) {
    for (let x = x1; x <= x2; x++) { px(img, x, y1 + k, c); px(img, x, y2 - k, c); }
    for (let y = y1; y <= y2; y++) { px(img, x1 + k, y, c); px(img, x2 - k, y, c); }
  }
}
function fill(img, x1, y1, x2, y2, c) { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) px(img, x, y, c); }
function label(img, x, y, text, c, s) {
  const w = text.length * 4 * s + s, h = 7 * s;
  if (x + w > img.width) x = img.width - w;
  if (y < 0) y = 0;
  fill(img, x, y, x + w - 1, y + h - 1, c);
  [...text].forEach((ch, i) => {
    const g = GLYPH[ch]; if (!g) return;
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r][q] === "1")
      fill(img, x + s + (i * 4 + q) * s, y + s + r * s, x + s + (i * 4 + q) * s + s - 1, y + s + r * s + s - 1, [255, 255, 255]);
  });
}

// Draw numbered boxes (element.index) on an already-scaled image. Bounds are in device pixels.
export function annotate(img, elements, scale) {
  const s = Math.max(3, Math.round(Math.min(img.width, img.height) / 180));
  for (const e of elements) {
    if (!e.bounds) continue;
    const c = PALETTE[e.index % PALETTE.length];
    const x1 = Math.round(e.bounds.x1 * scale), y1 = Math.round(e.bounds.y1 * scale);
    const x2 = Math.round(e.bounds.x2 * scale) - 1, y2 = Math.round(e.bounds.y2 * scale) - 1;
    rect(img, x1 - 1, y1 - 1, x2 + 1, y2 + 1, [0, 0, 0], 1);
    rect(img, x1, y1, x2, y2, c, 3);
    const t = String(e.index), lw = t.length * 4 * s + s;
    fill(img, x1 - 1, y1 - 1, x1 + lw, y1 + 7 * s, [0, 0, 0]);
    label(img, x1, y1, t, c, s);
  }
  return img;
}

export function decodeJpeg(buf) {
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: d.data };
}

export function encodeJpeg(img, quality = 70) {
  return jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data;
}

// Scale so the long edge <= maxEdge and total pixels <= maxPixels (what vision models actually use).
export function fitScale(w, h, maxEdge = 1568, maxPixels = 1_150_000) {
  return Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
}

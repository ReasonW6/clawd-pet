// Copies the clawd-400 GIF pack into ui/assets/clawd/<slug>.gif and writes a
// compact manifest the frontend can load.
// Usage: node scripts/import-assets.mjs [path-to-clawd-400]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] || path.join(root, "..", "clawd-400"));
const out = path.join(root, "ui", "assets", "clawd");

const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
fs.mkdirSync(out, { recursive: true });

/**
 * Index of the first non-transparent pixel in a frame's LZW data, or -1.
 * Tracks where each dictionary string first hits such a pixel, so nothing is expanded.
 */
function firstDrawn(data, minCode, transparent) {
  const clear = 1 << minCode;
  const len = new Uint32Array(4096);
  const head = new Uint16Array(4096);
  const hit = new Int32Array(4096);
  for (let i = 0; i < clear; i++) {
    len[i] = 1;
    head[i] = i;
    hit[i] = i === transparent ? -1 : 0;
  }
  let [size, next, prev, pos, acc, bits, p] = [minCode + 1, clear + 2, -1, 0, 0, 0, 0];
  for (;;) {
    while (bits < size && p < data.length) {
      acc |= data[p++] << bits;
      bits += 8;
    }
    if (bits < size) return -1;
    const code = acc & ((1 << size) - 1);
    acc >>= size;
    bits -= size;
    if (code === clear) {
      [size, next, prev] = [minCode + 1, clear + 2, -1];
      continue;
    }
    if (code === clear + 1) return -1;
    if (prev >= 0 && next < 4096) {
      // New string = previous string + first pixel of this one (or of itself, if not defined yet).
      const first = head[code < next ? code : prev];
      len[next] = len[prev] + 1;
      head[next] = head[prev];
      hit[next] = hit[prev] >= 0 ? hit[prev] : first !== transparent ? len[prev] : -1;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    if (hit[code] >= 0) return pos + hit[code];
    pos += len[code];
    prev = code;
  }
}

/** How far down the canvas (0..1) the highest pixel drawn by any frame of a GIF is. */
function contentTop(gif) {
  const height = gif.readUInt16LE(8);
  let p = 13 + (gif[10] & 0x80 ? 3 << ((gif[10] & 7) + 1) : 0);
  let transparent = -1;
  let top = height;
  const subBlocks = () => {
    const chunks = [];
    for (; gif[p]; p += gif[p] + 1) chunks.push(gif.subarray(p + 1, p + 1 + gif[p]));
    p++;
    return Buffer.concat(chunks);
  };
  for (;;) {
    const block = gif[p++];
    if (block === 0x21) {
      if (gif[p++] === 0xf9) transparent = gif[p + 1] & 1 ? gif[p + 4] : -1;
      subBlocks();
      continue;
    }
    // The trailer. Some files carry junk after the last frame instead; players stop there too.
    if (block !== 0x2c) return top / height;
    const [y, width, flags] = [gif.readUInt16LE(p + 2), gif.readUInt16LE(p + 4), gif[p + 8]];
    if (flags & 0x40) throw new Error("interlaced GIFs are not supported");
    p += 9 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
    const minCode = gif[p++];
    const data = subBlocks();
    if (y < top) {
      const i = firstDrawn(data, minCode, transparent);
      if (i >= 0) top = Math.min(top, y + Math.floor(i / width));
    }
    transparent = -1;
  }
}

const compact = manifest.map((m) => {
  const gif = fs.readFileSync(path.join(src, m.file));
  fs.writeFileSync(path.join(out, `${m.slug}.gif`), gif);
  return {
    slug: m.slug,
    zh: m.name.zh,
    en: m.name.en,
    theme: m.theme.id,
    themeZh: m.theme.zh,
    ms: m.durations_ms.reduce((a, b) => a + b, 0),
    // Where the drawing starts, so speech bubbles can sit just above it.
    top: Math.round(contentTop(gif) * 1000) / 1000,
  };
});

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(compact));
console.log(`Imported ${compact.length} animations into ${path.relative(root, out)}`);

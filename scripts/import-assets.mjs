// Imports the clawd-400 GIFs into ui/assets/clawd/<slug>.gif and writes a compact
// manifest the frontend can load.
// Usage: node scripts/import-assets.mjs [path-to-clawd-400]
//
// The source is either a clone of the clawd-400 repository (../clawd-400-src, whose
// generate.py renders gifs/ and manifest.json from the scene code) or the pack
// downloaded from its site (../clawd-400). The two write their manifests differently.
// With a clone, the pet's own scenes (scenes/*.py) are rendered with its engine and
// imported as well.
//
// The GIFs are 40x40 pixel art blown up to 480x480. They are stored at the size they
// were drawn in and the page scales them back up (`image-rendering: pixelated`),
// which leaves 144 times fewer pixels to decode and draw per frame.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(
  process.argv[2] || [path.join(root, "..", "clawd-400-src"), path.join(root, "..", "clawd-400")].find((d) => fs.existsSync(path.join(d, "manifest.json"))) || "",
);
const out = path.join(root, "ui", "assets", "clawd");

// The pet's own animations (scenes/*.py) are drawn with the clone's engine.
const sources = [src];
if (fs.existsSync(path.join(src, "engine.py"))) {
  const own = path.join(os.tmpdir(), "clawd-pet-scenes");
  const run = spawnSync("python", [path.join(root, "scripts", "render-scenes.py"), src, own], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
  sources.push(own);
} else {
  console.warn(`${src} is not a clone of clawd-400, so the pet's own animations in scenes/ are left out`);
}
const manifest = sources.flatMap((dir) => JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).map((m) => ({ ...m, dir })));
const dups = manifest.map((m) => m.slug).filter((s, i, all) => all.indexOf(s) !== i);
if (dups.length) throw new Error(`duplicate slugs: ${dups.join(", ")}`);
fs.mkdirSync(out, { recursive: true });

/** Theme names, as in clawd-400's site/build.py (the repository's manifest has only the
 *  id), and for the pet's own scenes. */
const THEME_ZH = { video: "视频重现", summer: "夏日篇", emotions: "情绪", life: "日常", dev: "编程", sports: "运动", costumes: "角色扮演", seasons: "节日季节", git: "Git", claude: "Claude Code", dream: "做梦", chat: "聊天", gaze: "眼神", peek: "躲边上" };

/** The grid the pixel art is drawn on. */
const ART = 40;

/** Expands a frame's LZW data into `count` palette indices. */
function unpack(data, minCode, count) {
  const indices = new Uint8Array(count);
  const clear = 1 << minCode;
  const len = new Uint16Array(4096);
  const head = new Uint8Array(4096);
  const last = new Uint8Array(4096);
  const before = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    len[i] = 1;
    head[i] = last[i] = i;
  }
  let [size, next, prev, pos, acc, bits, p] = [minCode + 1, clear + 2, -1, 0, 0, 0, 0];
  while (pos < count) {
    while (bits < size && p < data.length) {
      acc |= data[p++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>= size;
    bits -= size;
    if (code === clear) {
      [size, next, prev] = [minCode + 1, clear + 2, -1];
      continue;
    }
    if (code === clear + 1) break;
    if (prev >= 0 && next < 4096) {
      // New string = previous string + first pixel of this one (or of itself, if not defined yet).
      before[next] = prev;
      last[next] = head[code < next ? code : prev];
      head[next] = head[prev];
      len[next] = len[prev] + 1;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    for (let c = code, i = pos + len[code] - 1; i >= pos; i--, c = before[c]) {
      if (i < count) indices[i] = last[c];
    }
    pos += len[code];
    prev = code;
  }
  return indices;
}

/**
 * Plays a GIF through: its size, how often it repeats (0 = forever, null = not at
 * all), and every frame as it ends up on screen, { delay, pixels }. The delay is
 * in 1/100 s; a pixel is 0 where nothing is drawn and 0x1RRGGBB elsewhere.
 */
function decode(gif) {
  const [width, height] = [gif.readUInt16LE(6), gif.readUInt16LE(8)];
  const tableSize = (flags) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  const globalColors = gif.subarray(13, 13 + tableSize(gif[10]));
  let p = 13 + globalColors.length;
  const subBlocks = () => {
    const chunks = [];
    for (; gif[p]; p += gif[p] + 1) chunks.push(gif.subarray(p + 1, p + 1 + gif[p]));
    p++;
    return Buffer.concat(chunks);
  };

  const canvas = new Uint32Array(width * height);
  const frames = [];
  let loop = null;
  let control = { delay: 0, dispose: 0, transparent: -1 };
  for (;;) {
    const block = gif[p++];
    if (block === 0x21) {
      const label = gif[p++];
      if (label === 0xf9) {
        control = { delay: gif.readUInt16LE(p + 2), dispose: (gif[p + 1] >> 2) & 7, transparent: gif[p + 1] & 1 ? gif[p + 4] : -1 };
      }
      const body = subBlocks();
      if (label === 0xff && body.length >= 14 && body.toString("latin1", 0, 11) === "NETSCAPE2.0") loop = body.readUInt16LE(12);
      continue;
    }
    // The trailer. Some files carry junk after the last frame instead; players stop there too.
    if (block !== 0x2c) return { width, height, loop, frames };
    const [x, y, w, h, flags] = [gif.readUInt16LE(p), gif.readUInt16LE(p + 2), gif.readUInt16LE(p + 4), gif.readUInt16LE(p + 6), gif[p + 8]];
    if (flags & 0x40) throw new Error("interlaced GIFs are not supported");
    const colors = flags & 0x80 ? gif.subarray(p + 9, p + 9 + tableSize(flags)) : globalColors;
    p += 9 + tableSize(flags);
    const minCode = gif[p++];
    const indices = unpack(subBlocks(), minCode, w * h);

    const kept = control.dispose === 3 ? canvas.slice() : null;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = indices[j * w + i];
        if (c !== control.transparent) {
          canvas[(y + j) * width + x + i] = 0x1000000 | (colors[c * 3] << 16) | (colors[c * 3 + 1] << 8) | colors[c * 3 + 2];
        }
      }
    }
    frames.push({ delay: control.delay, pixels: canvas.slice() });
    if (control.dispose === 2) {
      for (let j = 0; j < h; j++) canvas.fill(0, (y + j) * width + x, (y + j) * width + x + w);
    } else if (kept) {
      canvas.set(kept);
    }
    control = { delay: 0, dispose: 0, transparent: -1 };
  }
}

/** A frame at ART x ART, or null if it isn't exactly that, blown up. */
function shrink(pixels, width, height) {
  const k = width / ART;
  if (width !== height || !Number.isInteger(k)) return null;
  const small = new Uint32Array(ART * ART);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = Math.floor(y / k) * ART + Math.floor(x / k);
      const c = pixels[y * width + x];
      if (x % k === 0 && y % k === 0) small[at] = c;
      else if (small[at] !== c) return null;
    }
  }
  return small;
}

/** Packs palette indices into a frame's LZW data, sub-blocks and all. */
function pack(indices, minCode) {
  const clear = 1 << minCode;
  const bytes = [];
  let [acc, bits, size, next] = [0, 0, minCode + 1, clear + 2];
  let codes = new Map(); // (string's code << 8 | next pixel) -> the longer string's code
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    for (; bits >= 8; bits -= 8, acc >>>= 8) bytes.push(acc & 255);
  };
  emit(clear);
  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = (prev << 8) | indices[i];
    const known = codes.get(key);
    if (known !== undefined) {
      prev = known;
      continue;
    }
    emit(prev);
    if (next === 4096) {
      emit(clear);
      [size, next, codes] = [minCode + 1, clear + 2, new Map()];
    } else {
      if (next >= 1 << size) size++;
      codes.set(key, next++);
    }
    prev = indices[i];
  }
  emit(prev);
  emit(clear + 1);
  if (bits) bytes.push(acc & 255);

  const data = [minCode];
  for (let i = 0; i < bytes.length; i += 255) data.push(Math.min(255, bytes.length - i), ...bytes.slice(i, i + 255));
  data.push(0);
  return data;
}

/** Writes ART x ART frames as a GIF, or returns null if they need more than one palette. */
function encode(frames, loop) {
  const palette = new Map([[0, 0]]); // pixel -> index; index 0 is the transparent one
  for (const f of frames) {
    for (const c of f.pixels) if (!palette.has(c)) palette.set(c, palette.size);
  }
  if (palette.size > 256) return null;
  const depth = Math.max(1, Math.ceil(Math.log2(palette.size)));
  const u16 = (n) => [n & 255, n >> 8];

  const gif = [...Buffer.from("GIF89a"), ...u16(ART), ...u16(ART), 0xf0 | (depth - 1), 0, 0];
  const colors = new Uint8Array(3 << depth);
  for (const [c, i] of palette) colors.set([(c >> 16) & 255, (c >> 8) & 255, c & 255], i * 3);
  gif.push(...colors);
  if (loop !== null) gif.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, ...u16(loop), 0);
  for (const f of frames) {
    // Each frame is the whole picture, cleared away again before the next one.
    gif.push(0x21, 0xf9, 4, 0x09, ...u16(f.delay), 0, 0);
    gif.push(0x2c, ...u16(0), ...u16(0), ...u16(ART), ...u16(ART), 0);
    gif.push(...pack(f.pixels.map((c) => palette.get(c)), Math.max(2, depth)));
  }
  gif.push(0x3b);
  return Buffer.from(gif);
}

/** How far down the canvas (0..1) the highest pixel drawn in any frame is. */
function contentTop({ width, height, frames }) {
  let top = height;
  for (const f of frames) {
    const first = f.pixels.findIndex((c) => c !== 0);
    if (first >= 0) top = Math.min(top, Math.floor(first / width));
  }
  return top / height;
}

let bytes = 0;
const compact = manifest.map((m) => {
  const original = fs.readFileSync(path.join(m.dir, m.file));
  const art = decode(original);
  const frames = art.frames.map((f) => ({ delay: f.delay, pixels: shrink(f.pixels, art.width, art.height) }));
  // Anything that isn't plain blown-up pixel art is kept the way it came.
  const gif = (frames.every((f) => f.pixels) && encode(frames, art.loop)) || original;
  if (gif === original) console.warn(`${m.slug}: kept at ${art.width}x${art.height}`);
  fs.writeFileSync(path.join(out, `${m.slug}.gif`), gif);
  bytes += gif.length;
  const theme = m.theme.id ?? m.theme;
  return {
    slug: m.slug,
    zh: m.name?.zh ?? m.zh,
    en: m.name?.en ?? m.en,
    theme,
    themeZh: m.theme.zh ?? THEME_ZH[theme] ?? theme,
    // From the frames that actually play, which is what the pet waits for.
    ms: art.frames.reduce((sum, f) => sum + f.delay * 10, 0),
    // Where the drawing starts, so speech bubbles can sit just above it.
    top: Math.round(contentTop(art) * 1000) / 1000,
  };
});

fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(compact));
console.log(`Imported ${compact.length} animations from ${sources.join(" and ")} into ${path.relative(root, out)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

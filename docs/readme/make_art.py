"""The README's pictures, drawn from the imported animations (ui/assets/clawd).

    python docs/readme/make_art.py

hero.gif    a desktop: Claude Code works through a task in a terminal while the pet
            follows along, asks for the permission in its bubble, and celebrates
claude.gif  cards: what it plays for the hook events
life.gif    cards under the sky of their hour: its own day
chat.gif    chatting with it: a search, then a setting changed on its word

The sprites stay 40 x 40 pixels scaled by a whole number, nearest neighbour; the rest is
drawn three times over and scaled down, so the type and the rounded corners are smooth.
Every GIF uses one palette for all its frames, so nothing that stands still flickers.
Needs Pillow, the Windows fonts Microsoft YaHei and Consolas, and `npm run import-assets`.
"""
import json
import math
import os
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
ASSETS = os.path.join(ROOT, "ui", "assets", "clawd")
FONTS = "C:/Windows/Fonts"

SS = 3  # supersampling for everything that isn't a sprite
STEP = 80  # ms per GIF frame

PAPER = (251, 246, 238)
CARD = (255, 255, 255)
INK = (43, 43, 43)
MUTED = (125, 118, 108)
LINE = (230, 221, 208)
ORANGE = (225, 127, 80)
SOFT = (251, 230, 218)
BUBBLE = (255, 250, 243)
SHADOW = (60, 40, 20, 40)
WHITE = (255, 255, 255)

# The terminal.
T_BG = (36, 32, 29)
T_BAR = (52, 47, 42)
T_TEXT = (232, 226, 216)
T_DIM = (150, 141, 129)
T_GREEN = (126, 198, 128)
T_RED = (226, 118, 104)
T_BLUE = (128, 176, 226)

MANIFEST = {m["slug"]: m for m in json.load(open(os.path.join(ASSETS, "manifest.json"), encoding="utf-8"))}


@lru_cache(None)
def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), round(size * SS))


def yahei(size, bold=False):
    return font("msyhbd.ttc" if bold else "msyh.ttc", size)


def mono(size, bold=False):
    return font("consolab.ttf" if bold else "consola.ttf", size)


# ----------------------------------------------------------------------------- sprites
@lru_cache(None)
class Sprite:
    """An animation as 40 x 40 RGBA frames with their durations."""

    def __init__(self, slug):
        im = Image.open(os.path.join(ASSETS, f"{slug}.gif"))
        self.frames, self.ms = [], []
        for fr in ImageSequence.Iterator(im):
            self.frames.append(fr.convert("RGBA"))
            self.ms.append(max(20, fr.info.get("duration", 100)))
        self.total = sum(self.ms)
        self.top = MANIFEST[slug]["top"]

    def at(self, t):
        t %= self.total
        for fr, ms in zip(self.frames, self.ms):
            if t < ms:
                return fr
            t -= ms
        return self.frames[-1]


def scaled(frame, k):
    return frame.resize((frame.width * k, frame.height * k), Image.NEAREST)


# ----------------------------------------------------------------------------- the 5 x 7 pixel type
GLYPHS = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
}


def pixel_word(text, scale, rgb):
    """A word in the 5 x 7 pixel type."""
    w = len(text) * 6 - 1
    im = Image.new("RGBA", (w, 7), (0, 0, 0, 0))
    px = im.load()
    for k, ch in enumerate(text):
        for r, row in enumerate(GLYPHS[ch]):
            for c, v in enumerate(row):
                if v == "#":
                    px[k * 6 + c, r] = rgb + (255,)
    return im.resize((im.width * scale, im.height * scale), Image.NEAREST)


def title(img, text, scale, rgb, shadow, xy, off=5):
    """A pixel word with a hard shadow `off` pixels down and to the right."""
    img.alpha_composite(pixel_word(text, scale, shadow), (xy[0] + off, xy[1] + off))
    img.alpha_composite(pixel_word(text, scale, rgb), xy)


# ----------------------------------------------------------------------------- smooth drawing
def is_cjk(ch):
    return ord(ch) >= 0x2E80 or ch in "，。：；！？～、“”「」…（）"


class Layer:
    """An RGBA picture drawn at SS x and scaled down when done. Coordinates are final pixels."""

    def __init__(self, w, h, fill=(0, 0, 0, 0)):
        self.w, self.h = w, h
        self.im = Image.new("RGBA", (w * SS, h * SS), fill)
        self.d = ImageDraw.Draw(self.im)

    def box(self, x0, y0, x1, y1, r, fill=None, outline=None, width=0):
        self.d.rounded_rectangle([x0 * SS, y0 * SS, x1 * SS - 1, y1 * SS - 1], r * SS, fill=fill, outline=outline, width=round(width * SS))

    def circle(self, cx, cy, r, fill):
        self.d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=fill)

    def card(self, x0, y0, x1, y1, r=12, fill=CARD, border=2, shadow=(3, 4)):
        """The settings window's card: an ink outline and a flat shadow down and to the right."""
        self.box(x0 + shadow[0], y0 + shadow[1], x1 + shadow[0], y1 + shadow[1], r, fill=SHADOW)
        self.box(x0, y0, x1, y1, r, fill=fill, outline=INK, width=border)

    def text(self, xy, s, f, fill, anchor="la"):
        self.d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=fill, anchor=anchor)

    def rich(self, x, y, s, size, fill, bold=False, code=False):
        """Left aligned at x, centred on y; Chinese in YaHei, the rest in Consolas when `code`."""
        for ch in s:
            f = yahei(size, bold) if is_cjk(ch) or not code else mono(size, bold)
            self.d.text((x * SS, y * SS), ch, font=f, fill=fill, anchor="lm")
            x += f.getlength(ch) / SS
        return x

    def rich_width(self, s, size, bold=False, code=False):
        return sum((yahei(size, bold) if is_cjk(ch) or not code else mono(size, bold)).getlength(ch) for ch in s) / SS

    def width(self, s, f):
        return f.getlength(s) / SS

    def poly(self, pts, fill):
        self.d.polygon([(x * SS, y * SS) for x, y in pts], fill=fill)

    def line(self, pts, fill, width):
        self.d.line([(x * SS, y * SS) for x, y in pts], fill=fill, width=round(width * SS), joint="curve")

    def done(self):
        return self.im.resize((self.w, self.h), Image.LANCZOS)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(w, h, top, bottom):
    g = Image.new("RGB", (1, h))
    for y in range(h):
        g.putpixel((0, y), mix(top, bottom, y / max(1, h - 1)))
    return g.resize((w, h)).convert("RGBA")


def wallpaper(w, h, top=(253, 246, 236), bottom=(247, 224, 203), dot=(238, 200, 170)):
    """A warm gradient with a halftone screen that grows toward the bottom right."""
    img = gradient(w, h, top, bottom)
    L = Layer(w, h)
    step = 14
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            v = 0.55 * x / w + 0.45 * y / h
            r = max(0.0, (v - 0.3) * 4.2)
            if r > 0.35:
                L.circle(x, y, min(r, 3.4), dot + (150,))
    img.alpha_composite(L.done())
    return img


def sparkle(L, x, y, size, color):
    """A four-pointed pixel star."""
    s = size
    L.box(x - s * 3, y - s / 2, x + s * 3, y + s / 2, 0, fill=color)
    L.box(x - s / 2, y - s * 3, x + s / 2, y + s * 3, 0, fill=color)
    L.box(x - s * 1.2, y - s * 1.2, x + s * 1.2, y + s * 1.2, 0, fill=color)


# ----------------------------------------------------------------------------- the pet's own UI
def bubble(L, cx, bottom, w, h, tail_x=None, right_limit=None):
    """The pet's bubble: paper, an ink outline, a tail pointing down at tail_x. Returns its box."""
    x0 = cx - w / 2
    if right_limit is not None and x0 + w > right_limit:
        x0 = right_limit - w
    y0 = bottom - h
    tx = tail_x if tail_x is not None else cx + 14
    tip = (tx - 12, bottom + 14)
    L.box(x0 + 2, y0 + 4, x0 + w + 2, y0 + h + 4, 18, fill=SHADOW)
    L.poly([(tx - 9 + 2, bottom + 1), (tx + 9 + 2, bottom + 1), (tip[0] + 2, tip[1] + 4)], fill=SHADOW)
    L.box(x0, y0, x0 + w, y0 + h, 18, fill=BUBBLE, outline=INK, width=2)
    L.poly([(tx - 9, bottom - 3), (tx + 9, bottom - 3), tip], fill=BUBBLE)
    L.line([(tx - 9, bottom - 1), tip, (tx + 9, bottom - 1)], INK, 2)
    return x0, y0, x0 + w, y0 + h


def check(L, x, y, color=ORANGE, s=1.0):
    L.line([(x, y), (x + 5 * s, y + 5 * s), (x + 14 * s, y - 6 * s)], color, 3 * s)


def status_label(L, cx, cy, text, quota=(3, 7)):
    """The dark label under the pet, with the two quota bars on its left."""
    f = yahei(15)
    tw = L.width(text, f)
    x0, x1 = cx - tw / 2 - 14, cx + tw / 2 + 14
    L.box(x0, cy - 14, x1, cy + 14, 14, fill=INK + (225,))
    L.text((cx, cy), text, f, WHITE, "mm")
    bx = x0 - 50
    for row, used in enumerate(quota):
        for c in range(10):
            x, y = bx + c * 4, cy - 7 + row * 8
            L.box(x, y, x + 3, y + 5, 0, fill=ORANGE if c < used else (255, 255, 255, 170))


def cursor(L, x, y, pressed=False):
    """A mouse pointer with its tip at (x, y)."""
    pts = [(0, 0), (0, 19), (5, 15), (9, 23), (12, 22), (8, 14), (14, 14)]
    k = 0.9 if pressed else 1.0
    L.poly([(x + px * k + 1.5, y + py * k + 2) for px, py in pts], fill=SHADOW)
    L.poly([(x + px * k, y + py * k) for px, py in pts], fill=INK)
    inner = [(1.6, 3.6), (1.6, 15.2), (5.4, 12.2), (9.2, 20.6), (10.4, 20.1), (6.6, 12.4), (11.2, 12.4)]
    L.poly([(x + px * k, y + py * k) for px, py in inner], fill=WHITE)


# ----------------------------------------------------------------------------- GIF output
SWATCHES = [PAPER, CARD, INK, MUTED, LINE, ORANGE, SOFT, BUBBLE, T_BG, T_BAR, T_TEXT, T_DIM, T_GREEN, T_RED, T_BLUE]


def save_gif(frames, path, ms=STEP):
    """Frames (RGB) with one shared palette; Pillow stores only what changed in each.
    The palette comes from a few frames plus big swatches of the named colours, so a
    colour that only covers a few pixels (a green bullet) isn't merged into a grey."""
    n = len(frames)
    picks = [frames[round(k * (n - 1) / 5)] for k in range(6)]
    fw, fh = picks[0].size
    sample = Image.new("RGB", (fw, fh * len(picks) + 200))
    for k, f in enumerate(picks):
        sample.paste(f, (0, k * fh))
    sw = fw // len(SWATCHES)
    for k, c in enumerate(SWATCHES):
        sample.paste(c, (k * sw, fh * len(picks), (k + 1) * sw, fh * len(picks) + 200))
    pal = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    out = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0, optimize=False, disposal=1)
    print(f"{os.path.relpath(path, ROOT)}: {frames[0].width}x{frames[0].height}, {n} frames, {os.path.getsize(path) // 1024} KB")


# ============================================================================= hero
W, H = 1280, 640
BAR = 592  # taskbar top
TX0, TY0, TX1, TY1 = 540, 70, 968, 512  # terminal window
K = 6
PET_CX = 1116
SPRITE_Y = BAR - 34 - 40 * K
HERO_MS = 11800

# What the pet plays when, and what it shows: (from ms, slug, label, bubble).
PET = [
    (0, "dev_thinking", "思考中…", ("line", "先看看测试为什么挂了")),
    (2600, "desk_typing", "编辑代码", ("line", "把超时从 5 秒改成 30 秒")),
    (5400, "emo_pretty_please", "等你确认", ("ask",)),
    (7600, "emo_thumbs_up", "运行命令", None),
    (8400, "cc_test_run", "跑测试", None),
    (9600, "dev_ship_it", "待命", ("done", "搞定啦，测试全绿")),
]
CLICK = 7300  # the pointer presses 允许

# The terminal's transcript: (from, until, typing ms, indent, bullet colour, segments).
TERM = [
    (0, None, 600, 0, None, [("> ", T_DIM), ("测试挂了，帮我看看", T_TEXT)]),
    (800, 2600, 0, 0, None, [("* ", ORANGE), ("Thinking…", T_DIM)]),
    (2600, None, 0, 0, T_GREEN, [("Read", T_TEXT), ("(src/server.rs)", T_DIM)]),
    (2750, None, 0, 1, None, [("└ ", T_DIM), ("Read 214 lines", T_DIM)]),
    (3300, None, 0, 0, T_GREEN, [("Update", T_TEXT), ("(src/server.rs)", T_DIM)]),
    (3450, None, 0, 1, None, [("└ ", T_DIM), ("Updated with 1 change", T_DIM)]),
    (3650, None, 0, 1, "-", [("- timeout: Duration::from_secs(5),", T_RED)]),
    (3800, None, 0, 1, "+", [("+ timeout: Duration::from_secs(30),", T_GREEN)]),
    (5400, None, 0, 0, ORANGE, [("Bash", T_TEXT), ("(npm test)", T_DIM)]),
    (7700, 9600, 0, 1, None, [("└ ", T_DIM), ("Running…", T_DIM)]),
    (9600, None, 0, 1, None, [("└ ", T_DIM), ("12 passed, 0 failed", T_GREEN)]),
    (10000, None, 900, 0, T_TEXT, [("搞定啦：超时改成 30 秒，测试全绿。", T_TEXT)]),
]
ASK_FROM, ASK_UNTIL = 5500, 7500

# Twinkling ones only on the right, where the terminal and the pet change anyway: one on
# the left would make every frame's changed area, and the GIF, several times bigger.
SPARKLES = [(1236, 92, 2.0, 0), (1020, 150, 1.4, 5), (1250, 260, 1.4, 9)]
STILL_SPARKLES = [(468, 140, 2.0), (520, 420, 1.5), (96, 548, 1.3), (330, 96, 1.2)]


def hero_static():
    img = wallpaper(W, H)
    L = Layer(W, H)
    # Left: what it is.
    tag = "开源 · Windows 桌宠"
    tw = L.width(tag, yahei(15, True)) + 32
    L.box(72, 104, 72 + tw, 104 + 32, 16, fill=INK)
    L.text((72 + tw / 2, 104 + 16), tag, yahei(15, True), WHITE, "mm")
    L.text((72, 394), "住在桌面上的 Claude Code 小螃蟹", yahei(26, True), INK)
    L.text((74, 444), "实时状态 · 气泡里审批 · 自己的作息 · AI 聊天", yahei(17), MUTED)
    L.text((74, 478), "Tauri 2 · Rust · HTML/JS", mono(16), MUTED)
    # The terminal.
    L.box(TX0 + 6, TY0 + 9, TX1 + 6, TY1 + 9, 14, fill=(60, 40, 20, 55))
    L.box(TX0, TY0, TX1, TY1, 14, fill=T_BG)
    L.box(TX0, TY0, TX1, TY0 + 36, 14, fill=T_BAR)
    L.box(TX0, TY0 + 20, TX1, TY0 + 36, 0, fill=T_BAR)
    for k, c in enumerate(((226, 118, 104), (232, 190, 96), (126, 198, 128))):
        L.circle(TX0 + 20 + k * 18, TY0 + 18, 5.5, c)
    L.text(((TX0 + TX1) / 2, TY0 + 18), "claude  ·  ~/clawd-pet", mono(14), T_DIM, "mm")
    # The taskbar.
    L.box(0, BAR, W, H, 0, fill=(255, 255, 255, 185))
    L.line([(0, BAR), (W, BAR)], (230, 214, 196), 1.5)
    cx = W / 2
    icons = [((52, 47, 42), ">_"), ((244, 200, 120), ""), ((128, 176, 226), ""), (ORANGE, "")]
    for k, (c, mark) in enumerate(icons):
        x = cx - 86 + k * 46
        L.box(x, BAR + 10, x + 30, BAR + 40, 7, fill=c)
        if mark:
            L.text((x + 15, BAR + 25), mark, mono(13, True), T_TEXT, "mm")
    L.box(cx - 86 + 8, BAR + 43, cx - 86 + 22, BAR + 45, 1, fill=ORANGE)  # the terminal is open
    L.text((W - 24, BAR + 17), "14:32", mono(15), INK, "rm")
    L.text((W - 24, BAR + 34), "2026/11/25", mono(11), MUTED, "rm")
    for x, y, s in STILL_SPARKLES:
        sparkle(L, x, y, s, (255, 255, 255, 230))
    img.alpha_composite(L.done())
    title(img, "CLAWD", 13, ORANGE, (236, 196, 168), (72, 160))
    title(img, "PET", 13, INK, (214, 196, 178), (72, 160 + 7 * 13 + 22))
    return img


def term_layer(t):
    L = Layer(W, H)
    x0, y = TX0 + 22, TY0 + 62
    lh = 23
    for at, until, typing, indent, bullet, segs in TERM:
        if t < at or (until is not None and t >= until):
            continue
        shown = sum(len(s) for s, _ in segs)
        if typing:
            shown = int(shown * min(1, (t - at) / typing))
        x = x0 + indent * 20
        if bullet in ("-", "+"):
            L.box(x - 6, y - 11, TX1 - 18, y + 11, 3, fill=((86, 44, 40) if bullet == "-" else (40, 74, 46)))
        elif bullet is not None:
            L.circle(x + 4, y, 4, bullet)
            x += 18
        for s, c in segs:
            part = s[:max(0, shown)]
            shown -= len(s)
            if part:
                x = L.rich(x, y, part, 15, c, code=True)
        if typing and t - at < typing + 400 and (t // 400) % 2 == 0:
            L.box(x + 2, y - 9, x + 10, y + 9, 0, fill=T_TEXT)
        y += lh
    if ASK_FROM <= t < ASK_UNTIL:
        bx0, by0, bx1 = x0, y + 6, TX1 - 22
        L.box(bx0, by0, bx1, by0 + 112, 8, outline=(110, 100, 90), width=1.5)
        L.rich(bx0 + 16, by0 + 22, "Bash command", 15, T_BLUE, bold=True, code=True)
        L.rich(bx0 + 16, by0 + 46, "npm test", 15, T_TEXT, code=True)
        L.rich(bx0 + 16, by0 + 72, "Do you want to proceed?", 15, T_DIM, code=True)
        L.rich(bx0 + 16, by0 + 95, "> 1. Yes   2. No", 15, T_TEXT, code=True)
    return L.done()


def pet_state(t):
    cur = PET[0]
    for p in PET:
        if t >= p[0]:
            cur = p
    return cur


def pet_layer(t, sprite_top):
    start, slug, label, bub = pet_state(t)
    L = Layer(W, H)
    status_label(L, PET_CX, BAR - 18, label)
    if bub and t - start >= 240:
        bottom = SPRITE_Y + sprite_top * 40 * K - 16
        if bub[0] == "ask":
            w, h = 300, 132
            x0, y0, _, _ = bubble(L, PET_CX, bottom, w, h, tail_x=PET_CX + 10, right_limit=W - 16)
            L.text((x0 + 18, y0 + 26), "Bash", yahei(16, True), INK, "lm")
            L.text((x0 + w - 18, y0 + 26), "允许它运行吗？", yahei(14), MUTED, "rm")
            L.box(x0 + 16, y0 + 44, x0 + w - 16, y0 + 76, 8, fill=(244, 238, 229))
            L.text((x0 + 28, y0 + 60), "$ npm test", mono(16), INK, "lm")
            by = y0 + 90
            pressed = t >= CLICK
            for k, (name, fill, ink) in enumerate((("允许", ORANGE, WHITE), ("总是允许", CARD, INK), ("拒绝", CARD, INK))):
                bw = (64, 92, 64)[k]
                bx = x0 + 16 + (0, 74, 176)[k]
                if k == 0 and pressed:
                    fill = (196, 98, 58)
                L.box(bx, by, bx + bw, by + 30, 15, fill=fill, outline=INK, width=2)
                L.text((bx + bw / 2, by + 15), name, yahei(14, k == 0), ink, "mm")
            # The pointer comes in from below and presses 允许.
            target = (x0 + 16 + 40, by + 18)
            p = min(1, max(0, (t - 6500) / 700))
            p = 1 - (1 - p) ** 3
            sx, sy = PET_CX - 40, BAR - 60
            if t >= 6500:
                cursor(L, sx + (target[0] - sx) * p, sy + (target[1] - sy) * p, pressed and t < CLICK + 160)
        else:
            text = bub[1]
            f = yahei(17)
            w = L.width(text, f) + (62 if bub[0] == "done" else 40)
            x0, y0, x1, y1 = bubble(L, PET_CX, bottom, w, 46, tail_x=PET_CX + 10, right_limit=W - 16)
            if bub[0] == "done":
                check(L, x0 + 22, y0 + 23)
                L.text((x0 + 44, y0 + 23), text, f, INK, "lm")
            else:
                L.text(((x0 + x1) / 2, y0 + 23), text, f, INK, "mm")
    return L.done(), slug


def hero():
    bg = hero_static()
    tops = {"dev_ship_it": 0.42}
    frames = []
    for t in range(0, HERO_MS, STEP):
        im = bg.copy()
        S = Layer(W, H)
        for x, y, s, phase in SPARKLES:
            k = (t // STEP + phase * 3) % 24
            if k < 12:
                sparkle(S, x, y, s * (0.6 + 0.4 * math.sin(math.pi * k / 12)), (255, 255, 255, 230))
        im.alpha_composite(S.done())
        im.alpha_composite(term_layer(t))
        start, slug, _, _ = pet_state(t)
        sp = Sprite(slug)
        im.alpha_composite(scaled(sp.at(t - start), K), (PET_CX - 20 * K, SPRITE_Y))
        layer, _ = pet_layer(t, tops.get(slug, sp.top))
        im.alpha_composite(layer)
        frames.append(im.convert("RGB"))
    save_gif(frames, os.path.join(HERE, "hero.gif"))


# ============================================================================= rows of cards
CW, CH = 176, 236
GAP, MARGIN = 18, 26
CK = 4
ART = 160  # the square the sprite sits in


def strip(cards, path, backdrop, ms=3200, header=None):
    """Cards of (slug, name, caption). `backdrop(k, t)` draws card k's square behind the
    sprite (an RGBA image of ART x ART); `header(L, x, y, card)` draws above it."""
    n = len(cards)
    w = MARGIN * 2 + n * CW + (n - 1) * GAP
    h = MARGIN * 2 + CH
    img = wallpaper(w, h, top=(252, 247, 239), bottom=(248, 233, 216), dot=(240, 214, 190))
    L = Layer(w, h)
    spots = []
    for k, card in enumerate(cards):
        slug, name, caption = card
        x = MARGIN + k * (CW + GAP)
        L.card(x, MARGIN, x + CW, MARGIN + CH)
        L.text((x + CW / 2, MARGIN + ART + 30), name, yahei(17, True), INK, "mm")
        L.text((x + CW / 2, MARGIN + ART + 54), caption, mono(13) if caption.isascii() else yahei(13), MUTED, "mm")
        spots.append((Sprite(slug), x + (CW - ART) // 2, MARGIN + 8))
    img.alpha_composite(L.done())
    mask = Layer(ART, ART)
    mask.box(0, 0, ART, ART, 8, fill=(255, 255, 255, 255))
    mask = mask.done().split()[3]
    frames = []
    for t in range(0, ms, STEP):
        im = img.copy()
        for k, (sp, x, y) in enumerate(spots):
            tile = backdrop(k, t)
            tile.alpha_composite(scaled(sp.at(t), CK), ((ART - 40 * CK) // 2, ART - 40 * CK))
            im.paste(tile, (x, y), mask)
        frames.append(im.convert("RGB"))
    save_gif(frames, path)


def plain_backdrop(k, t):
    """A plain warm white: the animations speak for themselves."""
    return Image.new("RGBA", (ART, ART), (253, 249, 243, 255))


SKIES = [  # top, bottom, sun or moon, stars
    ((255, 214, 170), (196, 226, 244), ("sun", (255, 196, 110), 0.25), False),
    ((150, 205, 245), (214, 238, 252), ("sun", (255, 220, 120), 0.12), False),
    ((180, 214, 240), (250, 232, 205), ("sun", (255, 200, 120), 0.2), False),
    ((246, 150, 110), (255, 214, 160), ("sun", (255, 120, 80), 0.42), False),
    ((90, 78, 150), (196, 128, 160), ("moon", (250, 236, 190), 0.18), True),
    ((26, 32, 64), (52, 60, 104), ("moon", (250, 236, 190), 0.12), True),
]


def sky_backdrop():
    tiles = []
    for k, (top, bottom, (body, color, y), stars) in enumerate(SKIES):
        img = gradient(ART, ART, top, bottom)
        L = Layer(ART, ART)
        cx, cy = ART - 34, ART * y + 10
        if body == "sun":
            L.circle(cx, cy, 20, color + (90,))
            L.circle(cx, cy, 13, color)
        else:
            L.circle(cx, cy, 12, color)
            L.circle(cx + 6, cy - 5, 11, mix(top, bottom, (cy - 5) / ART) + (255,))
        img.alpha_composite(L.done())
        tiles.append((img, stars, k))

    def draw(k, t):
        img, stars, seed = tiles[k]
        img = img.copy()
        if stars:
            L = Layer(ART, ART)
            for s in range(7):
                x = 14 + (s * 37 + seed * 11) % (ART - 60)
                y = 12 + (s * 23 + seed * 7) % 70
                on = ((t // STEP) + s * 5) % 20 < 14
                sparkle(L, x, y, 1.0 if on else 0.6, (255, 250, 220, 255 if on else 120))
            img.alpha_composite(L.done())
        return img

    return draw


# ============================================================================= chat
CHW, CHH = 1194, 292
CHAT_MS = 10400
C_PET_X = 176
C_K = 5

# The pet: (from, slug).
CHAT_PET = [(0, "chat_listen"), (1000, "chat_ponder"), (2000, "desk_typing"), (3600, "desk_coffee"), (4800, "chat_listen"), (5900, "chat_ponder"), (6700, "desk_typing"), (7700, "desk_coffee")]
# The exchanges: (typing from, sent at, chip at, reply from, reply until, ends at, user, chip, reply).
EXCHANGES = [
    (200, 1000, 1700, 2000, 3500, 4700, "明天上海会下雨吗？", "搜了一下", "会的，明天下午有阵雨，出门记得带伞～"),
    (4900, 5800, 6400, 6700, 7600, CHAT_MS, "以后叫我老板", "改了设置", "好嘞老板！以后就这么叫你。"),
]


PANEL = (356, 20, 1168, 272)


def chat_static():
    img = wallpaper(CHW, CHH)
    L = Layer(CHW, CHH)
    L.text((44, 50), "双击它，聊两句", yahei(22, True), INK, "lm")
    L.text((44, 84), "会看屏幕、会上网搜索、会记事，", yahei(14), MUTED, "lm")
    L.text((44, 106), "说一声就帮你改设置", yahei(14), MUTED, "lm")
    x0, y0, x1, y1 = PANEL
    L.box(x0 + 5, y0 + 7, x1 + 5, y1 + 7, 18, fill=SHADOW)
    L.box(x0, y0, x1, y1, 18, fill=(255, 253, 249, 235), outline=INK, width=2)
    img.alpha_composite(L.done())
    return img


def chat_layer(t):
    L = Layer(CHW, CHH)
    ex = next((e for e in EXCHANGES if e[0] - 200 <= t < e[5]), None)
    # The input box, under the conversation.
    ix0, ix1, iy = PANEL[0] + 24, PANEL[2] - 24, PANEL[3] - 44
    L.box(ix0, iy - 22, ix1, iy + 22, 22, fill=WHITE, outline=INK, width=2)
    L.circle(ix1 - 24, iy, 14, ORANGE)
    L.line([(ix1 - 30, iy), (ix1 - 18, iy), (ix1 - 23, iy - 5)], WHITE, 2)
    if ex:
        typing_from, sent, chip_at, reply_from, reply_until, _, user, chip, reply = ex
        if typing_from <= t < sent:
            n = int(len(user) * min(1, (t - typing_from) / (sent - typing_from - 200)))
            x = L.rich(ix0 + 22, iy, user[:n], 17, INK)
            if (t // 400) % 2 == 0:
                L.box(x + 2, iy - 10, x + 4, iy + 10, 0, fill=ORANGE)
        else:
            L.rich(ix0 + 22, iy, "说点什么…", 17, (190, 180, 168))
        y = iy - 52
        # The reply, bottom up, then the chip, then the user's message above it.
        if t >= reply_from:
            n = int(len(reply) * min(1, (t - reply_from) / (reply_until - reply_from)))
            f = yahei(17)
            w = L.width(reply, f) + 40
            L.box(ix0 + 2, y - 23 + 4, ix0 + w + 2, y + 23 + 4, 18, fill=SHADOW)
            L.box(ix0, y - 23, ix0 + w, y + 23, 18, fill=BUBBLE, outline=INK, width=2)
            L.rich(ix0 + 20, y, reply[:n], 17, INK)
            y -= 40
        if t >= chip_at:
            f = yahei(13)
            cw = L.width(chip, f) + 24
            L.box(ix0, y - 13, ix0 + cw, y + 13, 13, fill=SOFT)
            L.text((ix0 + cw / 2, y), chip, f, ORANGE, "mm")
            y -= 42
        if t >= sent:
            f = yahei(17)
            w = L.width(user, f) + 36
            L.box(ix1 - w, y - 21, ix1, y + 21, 18, fill=INK)
            L.text((ix1 - w / 2, y), user, f, WHITE, "mm")
    return L.done()


def chat():
    bg = chat_static()
    frames = []
    for t in range(0, CHAT_MS, STEP):
        im = bg.copy()
        start, slug = CHAT_PET[0]
        for s, sl in CHAT_PET:
            if t >= s:
                start, slug = s, sl
        im.alpha_composite(scaled(Sprite(slug).at(t - start), C_K), (C_PET_X - 20 * C_K, CHH - 14 - 40 * C_K))
        im.alpha_composite(chat_layer(t))
        frames.append(im.convert("RGB"))
    save_gif(frames, os.path.join(HERE, "chat.gif"))


# ============================================================================= main
def main():
    hero()
    claude = [
        ("dev_thinking", "思考", "UserPromptSubmit"),
        ("desk_typing", "写代码", "PreToolUse · Edit"),
        ("cc_test_run", "跑测试", "PreToolUse · Bash"),
        ("emo_pretty_please", "等你确认", "PermissionRequest"),
        ("dev_ship_it", "搞定啦", "Stop"),
        ("emo_facepalm", "出错了", "PostToolUseFailure"),
    ]
    strip(claude, os.path.join(HERE, "claude.gif"), plain_backdrop)
    life = [
        ("life_brush_teeth", "洗漱", "早晨 07:00"),
        ("life_noodle_slurp", "午饭", "中午 12:00"),
        ("tea_sip", "下午茶", "下午 15:30"),
        ("sport_jogging", "慢跑", "傍晚 17:00"),
        ("guitar_chill", "弹吉他", "晚间 20:30"),
        ("life_bed_sleep", "睡觉", "深夜 23:00"),
    ]
    strip(life, os.path.join(HERE, "life.gif"), sky_backdrop())
    chat()


if __name__ == "__main__":
    main()

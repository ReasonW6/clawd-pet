"""Claude Code at work: one animation per kind of tool call, plus replacements for the
ones that were borrowed from elsewhere (tests, MCP, code search, compaction, subagents...).

Shared look: windows and panels are drawn the way dev.py draws them; a mouse pointer is
a small white arrow with a black edge; Clawd stays front-facing and below the action.
"""
import math
from engine import Canvas, GROUND, BX, BY, add, clawd, mini, rng, text_w, beats
import props as P


def LG(s):
    """Alternating walk legs."""
    return (1, 0, 1, 0) if s else (0, 1, 0, 1)


def lerp(a, b, p):
    return a + (b - a) * p


# --------------------------------------------------------------------------- shared art
CURSOR = ['K...', 'KK..', 'KWK.', 'KWWK', 'KWKK', 'KK..']


def cursor(f, x, y, click=False):
    """Mouse pointer with its tip at (x, y); click adds a burst around the tip."""
    x, y = int(x), int(y)
    if click:
        for dx, dy in ((-2, -2), (0, -3), (-3, 0), (2, -2), (-2, 2)):
            f.put(x + dx, y + dy, 'U')
    f.art(CURSOR, x, y)


def browser(f, x, y, w, h, tabs=1, active=0, load=None, bg='W'):
    """Browser window: tab strip, toolbar with address bar, page. Returns the page box."""
    f.rect(x, y, w, h, 'g')
    for i in range(tabs):
        f.rect(x + 2 + i * 7, y + 1, 6, 2, 'W' if i == active else 'G')
    f.rect(x + 1, y + 3, w - 2, 3, 'G')
    f.rect(x + 3, y + 4, w - 6, 1, 'W')
    if load is not None:
        f.rect(x + 3, y + 4, int((w - 6) * load), 1, 'B')
    f.rect(x + 1, y + 6, w - 2, h - 7, bg)
    return x + 1, y + 6, w - 2, h - 7


def panel(f, x, y, w, h, bg='k'):
    f.rect(x, y, w, h, 'g')
    f.rect(x + 1, y + 1, w - 2, h - 2, bg)


TICK = ['..C', 'C.C', '.C.']
CROSS = ['C.C', '.C.', 'C.C']


def tiny_tick(f, x, y, c='E'):
    f.art(TICK, x, y, cmap={'C': c})


def tiny_cross(f, x, y, c='R'):
    f.art(CROSS, x, y, cmap={'C': c})


# --------------------------------------------------------------------------- web search
MAG = ['.kk..', 'k..k.', 'k..k.', '.kk..', '...kk']


def web_search(f, t, n):
    k = t % n
    q = 'TAURI'
    typed = min(len(q), max(0, k - 1))
    pressed = k == 7
    f.rrect(1, 1, 38, 9, 'B' if pressed else 'G')
    f.rrect(2, 2, 36, 7, 'W')
    f.art(MAG, 4, 3)
    f.text(q[:typed], 11, 3, 'k')
    if k <= 6 and k % 2 == 0:
        f.rect(11 + (text_w(q[:typed]) + 1 if typed else 0), 3, 1, 5, 'B')
    if 8 <= k <= 10:
        P.spinner(f, 34, 5, k * 3, c='B', c2='G')
    results = [(14, 'E'), (18, 'B'), (11, 'P')]
    for i in range(0 if k < 11 else min(3, k - 10)):
        y = 12 + i * 3
        if k >= 18 and i == 1:
            f.rect(1, y - 1, 38, 4, 'y')
        f.rect(3, y, 2, 2, results[i][1])
        f.rect(7, y, results[i][0], 1, 'B')
        f.rect(7, y + 1, results[i][0] + 8, 1, 'G')
    s = t % 2
    if k <= 1:
        clawd(f, lookv=-1, eyes='blink' if k == 1 else 'normal')
    elif k <= 6:
        clawd(f, lookv=-1, eyes='focus', la='high' if s else 'side', ra='side' if s else 'high')
    elif k == 7:
        clawd(f, y=BY + 1, h=11, lookv=-1, eyes='focus', la='high', ra='high')
    elif k <= 10:
        clawd(f, lookv=-1, eyes='normal', legs=(0, 0, 0, 1 if s else 0))
    elif k <= 13:
        clawd(f, lookv=-1, eyes='big')
    elif k <= 17:
        clawd(f, lookv=-1, look=(-1, 1, -1, 0)[k - 14], eyes='focus')
    else:
        up = k % 2 == 0
        clawd(f, y=BY - (1 if up else 0), eyes='happy', la='up' if up else 'high', ra='high')
        P.sparkles(f, k, 4, [(3, 22), (36, 23), (34, 11)])


add('cc_web_search', '网页搜索', 'Web search', web_search, n=22,
    dur=[300, 200] + [130] * 5 + [260] + [150] * 3 + [150] * 3 + [260] * 4 + [300] * 4)


# --------------------------------------------------------------------------- read a web page
BLOBS = [(0, -3, 3, 2), (4, -1, 3, 3), (2, 2, 2, 2), (8, -4, 2, 2), (9, 1, 3, 2)]


def globe(f, cx, cy, r, t):
    f.disc(cx, cy, r, 'B')
    for bx, by, w, h in BLOBS:
        for i in range(w):
            for j in range(h):
                px = cx - r + (bx + i + t) % (2 * r + 1)
                py = cy + by + j
                if (px - cx) ** 2 + (py - cy) ** 2 <= (r - 0.5) ** 2:
                    f.put(px, py, 'E')
    f.ring(cx, cy, r + 1, 'b', 1.2)
    f.put(cx - r + 2, cy - r + 2, 'S')


READ_LINES = [(14, 'G'), (17, 'G'), (10, 'B'), (16, 'G'), ('img', 'S'), (15, 'G'), (12, 'G'),
              (17, 'G'), (9, 'U'), (16, 'G'), (13, 'G'), (17, 'G'), (8, 'G')]


def web_page(f, x, y, w, h, scroll, hi=None):
    f.rect(x, y, w, h, 'W')
    f.box(x, y, w, h, 'G')
    f.rect(x + 1, y + 1, w - 2, 2, 'B')
    f.put(x + 2, y + 1, 'W')
    yy = y + 4 - scroll
    for i, (lw, c) in enumerate(READ_LINES):
        if lw == 'img':
            for row in range(4):
                if y + 4 <= yy + row < y + h - 1:
                    f.rect(x + 2, yy + row, 8, 1, c)
            yy += 5
            continue
        if y + 4 <= yy < y + h - 1:
            if hi == i:
                f.rect(x + 1, yy - 1, w - 2, 3, 'y')
            f.rect(x + 2, yy, min(lw, w - 4), 1, 'k' if c == 'U' else c)
        yy += 2


def web_read(f, t, n):
    k = t % n
    globe(f, 8, 11, 6, t)
    s = t % 2
    if k <= 1:
        clawd(f, x=20, look=-1, lookv=-1, eyes='normal')
        return
    if k <= 3:
        x, y, w, h = [(10, 6, 6, 7), (13, 3, 12, 11)][k - 2]
        web_page(f, x, y, w, h, 0)
        clawd(f, x=20, look=-1, lookv=-1, eyes='big', la='high')
        return
    scroll = max(0, min(10, k - 7))
    found = k >= 18
    web_page(f, 16, 2, 23, 17, scroll, hi=8 if found else None)
    if found:
        P.check(f, 31, 4)
    if k == 4:
        clawd(f, x=20, eyes='big', lookv=-1, la='up', ra='up')
    elif k < 18:
        clawd(f, x=20, lookv=-1, look=(-1, 0, 1)[k % 3], eyes='blink' if k == 12 else 'normal',
              la='up', ra='up')
    else:
        clawd(f, x=20, y=BY + (1 if s else 0), lookv=-1, eyes='happy', la='up', ra='up')
        P.sparkles(f, k, 4, [(15, 22), (37, 21)])


add('cc_web_read', '读网页', 'Reading a web page', web_read, n=24,
    dur=[250, 200, 140, 140, 250] + [160] * 13 + [350] + [200] * 5)


# --------------------------------------------------------------------------- browser in the app's own pane
def browser_pane(f, t, n):
    k = t % n
    f.rect(1, 0, 38, 20, 'g')
    for i, c in enumerate('RUE'):
        f.put(3 + i * 2, 1, c)
    op = 0 if k < 2 else min(1.0, (k - 1) / 3)
    px = int(round(38 - 22 * op))
    f.rect(2, 3, px - 3, 16, 'k')
    f.rect(px - 6 if op else 30, 5, 6, 1, 'w')
    f.rect(4, 8, 8, 1, 'O')
    if k >= 1:
        f.rect(4, 10, 6, 1, 'O')
    if k >= 16:
        tiny_tick(f, 4, 13)
        f.rect(8, 14, 5, 1, 'O')
    if op:
        w = 38 - px
        f.rect(px - 1, 3, 1, 16, 'g')
        f.rect(px, 3, w, 16, 'W')
        f.rect(px, 3, w, 3, 'G')
        f.rect(px + 2, 4, w - 4, 1, 'W')
        if k in (11, 12):
            f.rect(px + 2, 4, (w - 4) * (k - 10) // 2, 1, 'B')
        if k < 13:
            f.rect(px + 2, 7, 10, 1, 'k')
            for i, lw in enumerate((18, 14, 16)):
                f.rect(px + 2, 9 + i * 1 + i, min(lw, w - 4), 1, 'G')
            f.rect(px + 2, 15, 9, 3, 'b' if k >= 10 else 'B')
            f.rect(px + 4, 16, 5, 1, 'W')
        else:
            f.rect(px + 1, 7, w - 2, 3, 'E')
            f.rect(px + 3, 8, 8, 1, 'W')
            for i, lw in enumerate((17, 12, 15)):
                f.rect(px + 2, 12 + i * 2, min(lw, w - 4), 1, 'G')
    path = [(12, 12), (15, 13), (18, 14), (21, 15), (23, 16)]
    if 5 <= k <= 9:
        cursor(f, *path[k - 5])
    elif 10 <= k <= 15:
        cursor(f, 23, 16, click=k == 10)
    s = t % 2
    if k <= 4:
        clawd(f, lookv=-1, look=1 if k >= 2 else 0, eyes='big' if k in (2, 3) else 'normal')
    elif k <= 9:
        clawd(f, lookv=-1, look=0 if k < 7 else 1, eyes='focus', ra='mid')
    elif k == 10:
        clawd(f, y=BY + 1, h=11, lookv=-1, look=1, eyes='focus', ra='high')
    elif k <= 15:
        clawd(f, lookv=-1, look=1, eyes='normal', legs=(0, 0, 0, 1 if s else 0))
    else:
        up = k % 2 == 0
        clawd(f, y=BY - (1 if up else 0), eyes='happy', la='up' if up else 'high', ra='high' if up else 'up')
        P.sparkles(f, k, 4, [(3, 23), (36, 24)])


add('cc_browser_pane', '内置浏览器操作', 'Driving the built-in browser', browser_pane, n=22,
    dur=[300, 250, 120, 120, 200] + [130] * 5 + [300] + [150, 150] + [200, 200, 200] + [250] * 6)


# --------------------------------------------------------------------------- an outside browser, by remote
def remote(f, hx, hy, t, waves):
    hx, hy = int(hx), int(hy)
    f.rect(hx + 2, hy - 9, 1, 5, 'g')
    f.put(hx + 2, hy - 10, 'R')
    f.rect(hx - 1, hy - 4, 4, 6, 'k')
    f.put(hx, hy - 3, 'R'); f.put(hx + 1, hy - 3, 'E')
    f.put(hx, hy - 1, 'G'); f.put(hx + 1, hy - 1, 'G')
    if waves:
        tx, ty = hx + 2, hy - 10
        for i in range(2):
            r = 2 + i * 2 + (t % 2)
            for a in (-135, -110, -90, -70, -45):
                f.put(tx + r * math.cos(math.radians(a)), ty + r * math.sin(math.radians(a)), 'C')


def browser_remote(f, t, n):
    k = t % n
    f.rect(15, 2, 26, 14, 'L')
    tabs = 1 if k < 8 else 2
    load = (k - 7) / 2 if k in (8, 9) else None
    x, y, w, h = browser(f, 13, 0, 26, 14, tabs=tabs, active=tabs - 1, load=load)
    if k < 10:
        f.rect(x + 1, y + 1, 6, 5, 'S')
        f.put(x + 5, y + 2, 'U')
        f.rect(x + 9, y + 1, 12, 1, 'k')
        f.rect(x + 9, y + 3, 14, 1, 'G')
        f.rect(x + 9, y + 5, 10, 1, 'P' if k >= 7 else 'B')
    else:
        sc = min(3, k - 10)
        f.rect(x, y, w, max(0, 3 - sc), 'P')
        for i, lw in enumerate((18, 14, 20, 12, 16)):
            yy = y + 4 + i * 2 - sc
            if y <= yy < y + h:
                f.rect(x + 2, yy, lw, 1, 'G')
    path = [(20, 8), (23, 9), (26, 10), (29, 11), (31, 11)]
    if 2 <= k <= 6:
        cursor(f, *path[k - 2])
    elif k <= 13:
        cursor(f, 31, 11, click=k == 7)
    s = t % 2
    pressing = k == 7
    if k == 0:
        info = clawd(f, x=1, look=1, lookv=-1, eyes='normal', ra='side')
    elif k < 14:
        info = clawd(f, x=1, y=BY + (1 if pressing else 0), h=11 if pressing else 12, look=1, lookv=-1,
                     eyes='squint' if pressing else 'focus', ra='side')
    else:
        info = clawd(f, x=1, y=BY - (1 if s else 0), look=1, eyes='happy', ra='side', la='up' if s else 'high')
        P.sparkles(f, k, 4, [(36, 20), (30, 30)])
    if k:
        hx, hy = info['rh']
        remote(f, hx, hy, t, 2 <= k <= 13)


add('cc_browser_remote', '遥控外部浏览器', 'Remote-controlling a browser', browser_remote, n=20,
    dur=[300, 250] + [150] * 5 + [300] + [150, 150] + [200] * 4 + [250] * 6)


# --------------------------------------------------------------------------- computer use
MOUSE = ['.GGG.', 'GgGgG', 'GGGGG', '.GGG.']


def desktop(f, k, win):
    f.rect(1, 0, 38, 20, 'k')
    f.rect(2, 1, 36, 15, 'S')
    f.rect(2, 13, 36, 3, 'E')
    f.rect(2, 16, 36, 2, 'g')
    f.rect(3, 16, 2, 2, 'B')
    f.rect(33, 16, 4, 1, 'W')
    for i, c in enumerate('UBP'):
        f.rect(4, 3 + i * 5, 3, 3, c)
        f.rect(4, 7 + i * 5, 3, 1, 'W')
    if win:
        wx, wy, ww, wh = [(10, 7, 10, 6), (12, 3, 22, 12)][win - 1]
        f.rect(wx, wy, ww, wh, 'g')
        f.rect(wx + 1, wy + 2, ww - 2, wh - 3, 'W')
        f.put(wx + ww - 2, wy + 1, 'R')
        return wx, wy, ww, wh
    return None


def computer_use(f, t, n):
    k = t % n
    win = 0 if k < 10 else (1 if k == 10 else 2)
    box = desktop(f, k, win)
    f.rect(18, 20, 4, 1, 'g')
    if box and k >= 12:
        wx, wy = box[0], box[1]
        for i in range(min(4, k - 11)):
            f.rect(wx + 2, wy + 4 + i * 2, (12, 16, 9, 14)[i], 1, 'k')
    if k in (1, 17):
        f.rect(2, 1, 36, 17, 'W')
    if k in (1, 2, 17, 18):
        for (cx, cy, dx, dy) in ((2, 1, 1, 1), (37, 1, -1, 1), (2, 17, 1, -1), (37, 17, -1, -1)):
            f.rect(cx if dx > 0 else cx - 3, cy, 4, 1, 'R')
            f.rect(cx, cy if dy > 0 else cy - 3, 1, 4, 'R')
    path = [(20, 10), (15, 10), (11, 9), (8, 9), (6, 9)]
    if 3 <= k <= 7:
        cx, cy = path[k - 3]
    elif k <= 9:
        cx, cy = 6, 9
    else:
        cx, cy = 26, 12
    if k >= 3 and k not in (1, 17):
        cursor(f, cx, cy, click=k in (8, 9))
    mdx = {3: 0, 4: -1, 5: -1, 6: -1, 7: -1}.get(k, -1 if 8 <= k <= 9 else 0)
    f.line(32, 29, 32, 21, 'k')
    f.art(MOUSE, 30 + mdx, 29)
    s = t % 2
    typing = 12 <= k <= 16
    if k in (1, 17):
        clawd(f, x=8, eyes='squint', ra='out')
    elif k <= 9:
        clawd(f, x=8, lookv=-1, look=-1 if k >= 4 else 0, eyes='focus' if k >= 3 else 'normal', ra='out')
    elif k <= 16:
        clawd(f, x=8, lookv=-1, eyes='big' if k in (10, 11) else 'focus', ra='out',
              la='high' if typing and s else 'side')
    else:
        clawd(f, x=8, y=BY + (1 if s else 0), eyes='happy', ra='out', la='high' if s else 'mid')
        P.sparkles(f, k, 4, [(3, 24), (36, 23)])


add('cc_computer_use', '操控电脑', 'Computer use', computer_use, n=22,
    dur=[300, 120, 250] + [120] * 5 + [120, 250] + [150, 150] + [130] * 5 + [120, 250] + [250, 250, 400])


# --------------------------------------------------------------------------- tests running (no verdict yet)
def test_run(f, t, n):
    k = t % n
    f.text('TEST', 2, 0, 'g')
    for i in range(3):
        if (k // 2) % 4 > i:
            f.rect(19 + i * 3, 4, 2, 1, 'g')
    f.rect(2, 17, 36, 2, 'N')
    for i, c in enumerate('CPYCPY'):
        x = 4 + i * 6
        level = 10 + (i * 2) % 3
        f.box(x, 6, 4, 11, 'G')
        f.rect(x + 1, level, 2, 16 - level, c)
        by = 15 - ((t + i * 3) % 8)
        if by >= level:
            f.put(x + 1 + (i + t // 2) % 2, by, 'W')
        else:
            f.put(x + 1 + i % 2, by - 1, 'W')
    s = t % 2
    sweat = 8 <= k <= 11
    info = clawd(f, eyes='blink' if k == 13 else 'worried', look=(-1, -1, 1, 1)[(k // 2) % 4],
                 la='low', ra='low', legs=(0, 0, 0, 1 if s else 0))
    if sweat:
        f.art(P.SWEAT, info['x'] + info['w'] + 1, info['y'] - 1 + (k - 8))


add('cc_test_run', '跑测试中', 'Tests running', test_run, n=16, dur=140)


# --------------------------------------------------------------------------- tests failed
def test_fail(f, t, n):
    k = t % n
    red = 7 <= k <= 9 and k % 2
    panel(f, 1, 1, 38, 19)
    if red:
        f.box(1, 1, 38, 19, 'R')
    rows = [(3, 18, 2), (7, 14, 4), (11, 20, 7)]
    for i, (y, lw, at) in enumerate(rows):
        if k < at - 1:
            continue
        if k == at - 1 or (i == 2 and k < at):
            f.put(4, y + 1, 'g' if k % 2 else 'G')
            f.rect(8, y + 1, lw, 1, 'g')
        elif i < 2:
            tiny_tick(f, 3, y)
            f.rect(8, y + 1, lw, 1, 'G')
        else:
            tiny_cross(f, 3, y)
            f.rect(8, y + 1, lw, 1, 'R')
    if k >= 8:
        f.text('FAIL', 8, 14, 'R')
    s = t % 2
    if k < 7:
        clawd(f, lookv=-1, eyes='normal' if k < 5 else 'focus')
    elif k == 7:
        clawd(f, y=BY - 2, eyes='big', la='up', ra='up', legs=(1, 1, 1, 1))
    elif k <= 9:
        clawd(f, eyes='big', lookv=-1, la='high', ra='high')
    else:
        info = clawd(f, y=BY + 1, h=11, eyes='sad', lookv=1, la='low', ra='low')
        if 11 <= k <= 14:
            f.art(P.SWEAT, info['x'] + info['w'] + 1, info['y'] - 1 + (k - 11))
        if k >= 13:
            f.art(P.PUFF_S, info['x'] - 3 - (k - 13), info['y'] + 6 - (k - 13))


add('cc_test_fail', '测试挂了', 'Tests failed', test_fail, n=16,
    dur=beats(16, 160, {(1, 3): 260, 5: 220, 6: 400, 7: 160, 8: 350, 15: 600}))


# --------------------------------------------------------------------------- MCP: slot in a cartridge
def cart(f, x, y, c):
    x, y = int(x), int(y)
    f.rect(x, y, 7, 7, c)
    f.rect(x + 1, y + 1, 5, 3, 'W')
    f.rect(x + 2, y + 2, 3, 1, c)
    for i in range(0, 7, 2):
        f.put(x + i, y + 6, 'Y')


def hub(f, lit, shake=0):
    f.rect(0 + shake, 24, 13, 12, 'k')
    f.rect(0 + shake, 24, 13, 1, 'g')
    f.rect(3 + shake, 24, 7, 1, 'K')
    f.text('MCP', 1 + shake, 27, 'W')
    for i in range(3):
        f.put(3 + i * 3 + shake, 33, 'E' if i < lit else 'g')


def mcp_cart(f, t, n):
    k = t % n
    c = 'P'
    pos = {0: (15, 11), 1: (9, 11), 2: (3, 13), 3: (3, 17), 18: (3, 14), 19: (9, 10)}
    cx, cy = pos.get(k, (3, 19))
    cart(f, cx, cy, c)
    lit = 0 if k < 5 or k >= 18 else min(3, k - 4)
    hub(f, lit, shake=(1 if k == 4 else 0))
    if k == 4:
        for dx in (1, 11):
            f.put(dx, 22, 'U')
    pk = {8: (8, 16), 9: (13, 11), 10: (19, 9), 11: (24, 10)}
    if k in pk:
        px, py = pk[k]
        f.rect(px, py, 2, 2, 'U')
        f.put(px - 2, py + 2, 'y')
    if 12 <= k <= 17:
        f.text('{}', 25, 12, 'B')
        P.sparkles(f, k, 4, [(23, 11), (34, 13)])
    s = t % 2
    if k == 0:
        clawd(f, x=18, eyes='normal', la='up', look=-1)
    elif k <= 3:
        clawd(f, x=18, eyes='focus', la='reach', look=-1)
    elif k == 4:
        clawd(f, x=18, y=BY + 1, h=11, eyes='squint', la='reach', look=-1)
    elif k <= 7:
        clawd(f, x=18, eyes='big', look=-1, lookv=1)
    elif k <= 11:
        clawd(f, x=18, eyes='normal', look=(-1, -1, 0, 1)[k - 8], lookv=-1)
    elif k <= 17:
        up = k % 2 == 0
        clawd(f, x=18, y=BY - (1 if up else 0), eyes='happy', la='up' if up else 'high', ra='high')
    else:
        clawd(f, x=18, eyes='big', la='reach', look=-1, lookv=-1)


add('cc_mcp_cart', 'MCP：插卡带', 'MCP: slot in a cartridge', mcp_cart, n=20,
    dur=[300, 160, 200, 160, 380, 200, 200, 200, 130, 130, 130, 130, 350, 200, 200, 200, 200, 300, 200, 200])


# --------------------------------------------------------------------------- code search: scroll and highlight
def _code_lines(seed=9, count=24):
    r = rng(seed)
    out = []
    for i in range(count):
        out.append((r.choice((0, 0, 2, 2, 4)), r.randint(4, 12), r.choice('BPGGEC')))
    return out


CODE = _code_lines()
MATCH = {3, 11, 18}


def code_search(f, t, n):
    k = t % n
    f.rect(1, 1, 21, 35, 'k')
    f.rect(1, 1, 21, 7, 'g')
    f.text(('A.RS', 'B.JS', 'C.PY')[k // 8], 3, 2, 'W')
    hit = False
    for i, (ind, lw, c) in enumerate(CODE):
        y = 9 + (i * 2 - k * 2) % (len(CODE) * 2)
        if not 9 <= y <= 34:
            continue
        if i in MATCH:
            if 17 <= y <= 21:
                f.rect(4, y - 1, 18, 3, 'Y')
                hit = hit or 19 <= y <= 21
            f.put(3, y, 'U')
        f.rect(5 + ind, y, lw, 1, 'k' if (i in MATCH and 17 <= y <= 21) else c)
    f.art(['U.', 'UU', 'U.'], 1, 18)
    s = t % 2
    info = clawd(f, x=23, y=BY + (1 if s and not hit else 0), look=-1, eyes='big' if hit else 'focus',
                 la='reach')
    if hit:
        f.art(P.EXCL, info['x'] + 8, info['y'] - 7, cmap={'K': 'U'})


add('cc_code_search', '翻代码找匹配', 'Searching the code', code_search, n=24, dur=120)


# --------------------------------------------------------------------------- compaction: roll up the long scroll
def scroll_roll(f, x, thick):
    w = 2 + thick
    f.rect(x, 5, w, 11, 'y')
    f.rect(x + w - 1, 5, 1, 11, 'Y')
    c = x + w // 2
    f.rect(c, 3, 1, 15, 'n')
    f.rect(c - 1, 3, 3, 1, 'N'); f.rect(c - 1, 17, 3, 1, 'N')


def compact_scroll(f, t, n):
    k = t % n
    if k <= 11:
        p = 0 if k <= 1 else (k - 1) / 10
        thick = 1 + int(round(2 * p))
        lx = int(round(1 + 15 * p))
        rx = int(round(36 - 15 * p))
        w = 2 + thick
        f.rect(lx + w, 6, rx - lx - w, 9, 'T')
        for i, (yy, c) in enumerate(((7, 'B'), (9, 'g'), (11, 'g'), (13, 'g'))):
            for x in range(3, 37, 6):
                if lx + w <= x and x + 4 <= rx:
                    f.rect(x, yy, 4 if c == 'g' else 3, 1, c)
        scroll_roll(f, lx, thick)
        scroll_roll(f, rx - (w - 1), thick)
    else:
        f.rect(15, 5, 10, 11, 'y')
        f.rect(15, 5, 1, 11, 'Y'); f.rect(24, 5, 1, 11, 'Y'); f.rect(19, 5, 2, 11, 'Y')
        for c in (17, 22):
            f.rect(c, 3, 1, 15, 'n')
            f.rect(c - 1, 3, 3, 1, 'N'); f.rect(c - 1, 17, 3, 1, 'N')
        if k >= 13:
            f.rect(15, 9, 10, 2, 'R')
        if k >= 14:
            f.art(['RR.RR', '.RRR.', 'R...R'], 18, 7 if k == 14 else 6)
        if k == 12:
            P.dust(f, 10, 12, 0.3); P.dust(f, 26, 12, 0.3, flip=True)
    s = t % 2
    if k <= 1:
        clawd(f, lookv=-1, eyes='normal' if k == 0 else 'focus', la='high', ra='high')
    elif k <= 11:
        clawd(f, lookv=-1, eyes='focus', la='mid' if s else 'high', ra='high' if s else 'mid',
              legs=(0, 0, 0, 1 if s else 0))
    elif k <= 14:
        clawd(f, lookv=-1, eyes='big' if k == 12 else 'normal', la='high', ra='high')
    else:
        up = k % 2 == 0
        clawd(f, y=BY - (1 if up else 0), eyes='happy', la='up', ra='up')
        P.sparkles(f, k, 4, [(9, 7), (31, 9), (4, 18), (35, 17)])


add('cc_compact_scroll', '卷起长卷轴', 'Rolling up the long scroll', compact_scroll, n=22,
    dur=[350, 200] + [130] * 10 + [350, 250, 300] + [220] * 6 + [500])


# --------------------------------------------------------------------------- writing code: lay the lines like bricks
BRICKS = [(0, 12, 'P'), (3, 9, 'B'), (3, 14, 'E'), (6, 7, 'Y'), (0, 3, 'P')]


def code_bricks(f, t, n):
    k = t % n
    panel(f, 2, 0, 36, 19)
    for i in range(5):
        f.put(4, 3 + i * 3, 'g')
    line, phase = divmod(k, 3)
    if k >= 15:
        line, phase = 5, 0
    for i, (ind, lw, c) in enumerate(BRICKS):
        if i < line or (i == line and phase == 2):
            f.rect(7 + ind, 2 + i * 3, lw, 2, c)
    if k >= 15 and k % 2:
        f.box(2, 0, 36, 19, 'U')
    s = t % 2
    if line < 5:
        ind, lw, c = BRICKS[line]
        tx, ty = 7 + ind, 2 + line * 3
        hx, hy = 20 - lw // 2, 16
        if phase == 0:
            f.rect(hx, hy, lw, 2, c)
            clawd(f, eyes='focus', la='up', ra='up', lookv=-1)
        elif phase == 1:
            f.rect(int(lerp(hx, tx, 0.5)), int(lerp(hy, ty, 0.5)) - 3, lw, 2, c)
            clawd(f, y=BY - 1, eyes='normal', la='high', ra='high', lookv=-1)
        else:
            f.art(['.W.', 'WUW', '.W.'], tx + lw, ty - 1)
            clawd(f, eyes='happy', lookv=-1)
    else:
        up = k % 2 == 1
        clawd(f, y=BY - (2 if up else 0), eyes='happy', la='up' if up else 'high', ra='up' if up else 'high',
              legs=(1, 1, 1, 1) if up else (0, 0, 0, 0))
        P.sparkles(f, k, 4, [(3, 24), (36, 23)])


add('cc_code_bricks', '一行行搭代码', 'Laying code like bricks', code_bricks, n=20,
    dur=[260, 130, 200] * 5 + [200, 200, 200, 200, 400])


# --------------------------------------------------------------------------- done: crown the tower
STAR = ['..U..', '.UUU.', 'UUUUU', '.UUU.', '.U.U.']


def tower(f, glow=False):
    for x, y, w, c, hi in ((2, 30, 12, 'B', 'S'), (3, 24, 10, 'P', 'p'), (4, 18, 8, 'E', 'y')):
        f.rect(x, y, w, 6, c)
        f.rect(x, y, w, 1, hi)
        if glow:
            f.box(x - 1, y - 1, w + 2, 8, 'U')


def task_tower(f, t, n):
    k = t % n
    tower(f, glow=k in (7, 9))
    s = t % 2
    if k <= 3:
        x = 20 - max(0, k - 1) * 2
        info = clawd(f, x=x, y=BY + (s if k >= 2 else 0), look=-1, eyes='normal', la='up', ra='up',
                     legs=LG(s) if k >= 2 else (0, 0, 0, 0))
        f.art(STAR, x + 6, 13)
        return
    if k == 4:
        clawd(f, x=16, y=BY + 2, h=10, look=-1, eyes='focus', la='up', ra='up')
        f.art(STAR, 22, 15)
        return
    if k == 5:
        clawd(f, x=16, y=BY - 3, look=-1, eyes='focus', la='up', ra='high', legs=(1, 1, 1, 1))
        f.art(STAR, 11, 8)
        return
    f.art(STAR if (k % 2 or k < 10) else ['..W..', '.WUW.', 'WUUUW', '.WUW.', '.W.W.'], 6, 13)
    if k == 6:
        clawd(f, x=16, look=-1, eyes='big', la='up')
        P.sparkles(f, 0, 4, [(4, 12), (12, 12)])
        return
    if k <= 9:
        clawd(f, x=18, look=-1, eyes='big' if k == 7 else 'normal', la='mid', ra='mid')
        return
    clawd(f, x=20, y=BY + (1 if k % 4 == 0 else 0), look=-1, eyes='happy' if k < 16 else 'closed',
          la='side' if k >= 14 else 'mid', ra='side' if k >= 14 else 'mid')
    P.sparkles(f, k, 4, [(3, 11), (13, 14), (1, 22), (16, 27)])


add('cc_task_tower', '收工：塔顶放星星', 'Done: star on top', task_tower, n=18,
    dur=[300, 200, 150, 150, 220, 120, 380, 200, 160, 200] + [200] * 7 + [500])


# --------------------------------------------------------------------------- subagents: send them off
def mini_with_task(f, x, c, view='front', step=0, salute=False):
    y = 28
    mini(f, x, y, eyes='normal', la='up', ra='high' if salute else 'side', view=view,
         legs=((1, 0, 1, 0) if step % 2 else (0, 1, 0, 1)) if view != 'front' else (0, 0, 0, 0))
    f.rect(x - 3, y - 7, 4, 5, 'W')
    f.box(x - 3, y - 7, 4, 5, 'g')
    f.rect(x - 2, y - 5, 2, 1, c)


def agent_dispatch(f, t, n):
    k = t % n
    s = t % 2
    if k <= 1:
        clawd(f, x=2, look=1, eyes='normal' if k == 0 else 'focus', lookv=-1 if k == 1 else 0)
        return
    if k >= 17:
        clawd(f, x=2, look=1, eyes='happy', la='wave' if s else 'high', ra='wave' if not s else 'high')
        for i in range(3):
            if (k + i) % 2:
                f.put(37, 26 + i * 3, 'L')
        return
    j, p = divmod(k - 2, 5)
    c = 'BPE'[j]
    if p == 0:
        clawd(f, x=2, y=BY + 1, h=11, look=1, eyes='squint', la='high', ra='high')
        f.art(P.PUFF, 25, 27); f.art(P.PUFF, 30, 29); f.art(P.PUFF_S, 28, 25)
    elif p == 1:
        clawd(f, x=2, look=1, eyes='happy', la='side', ra='mid')
        mini_with_task(f, 26, c, salute=True)
    else:
        clawd(f, x=2, look=1, eyes='normal', ra='wave' if p == 3 else 'mid')
        x = 26 + (p - 1) * 5
        mini_with_task(f, x, c, view='qr', step=p)
        P.dust(f, x - 4, 34, 0.3)


add('cc_agent_dispatch', '派出子代理', 'Sending out subagents', agent_dispatch, n=20,
    dur=[300, 300] + [220, 330, 120, 110, 110] * 3 + [250, 250, 400])


# --------------------------------------------------------------------------- subagents: watching them work
RUNNER = [['OOOOO', 'OKOKO', 'OOOOO', 'O.O.O'], ['OOOOO', 'OKOKO', 'OOOOO', '.O.O.']]


def agent_wait(f, t, n):
    k = t % n
    panel(f, 1, 0, 38, 18)
    arrived = []
    for i, (spd, off, c) in enumerate(((1, 0, 'B'), (2, 7, 'P'), (1, 14, 'E'))):
        y = 3 + i * 5
        for x in range(4, 31, 2):
            f.put(x, y + 3, 'g')
        f.box(32, y, 5, 5, 'g')
        u = (t * spd + off) % 24
        if u < 3 * spd:
            tiny_tick(f, 33, y + 1)
            arrived.append(i)
        x = 3 + int(u / 24 * 25)
        f.art(RUNNER[(t + i) % 2], x, y)
        f.put(x - 1, y, c); f.put(x - 1, y + 1, c)
    s = t % 2
    happy = bool(arrived) and any((t * spd + off) % 24 < spd for spd, off in ((1, 0), (2, 7), (1, 14)))
    info = clawd(f, lookv=-1, look=1 if arrived else (-1, 0, 1, 0)[(k // 3) % 4],
                 eyes='happy' if happy else ('blink' if k == 17 else 'normal'), ra='high')
    hx, hy = int(info['rh'][0]), int(info['rh'][1])
    f.rect(hx - 1, hy - 4, 3, 6, 'k')
    f.put(hx, hy - 3, 'E' if s else 'g')
    f.rect(hx + 1, hy - 7, 1, 3, 'g')
    if s:
        f.put(hx + 3, hy - 8, 'C'); f.put(hx + 4, hy - 6, 'C')


add('cc_agent_wait', '盯着子代理干活', 'Watching subagents work', agent_wait, n=24, dur=130)


# --------------------------------------------------------------------------- the Claude app opens
def app_window(f, x, y, w, h, body='k'):
    f.rect(x, y, w, h, 'g')
    for i, c in enumerate('RUE'):
        f.put(x + 2 + i * 2, y + 1, c)
    f.rect(x + 1, y + 3, w - 2, h - 4, body)


def app_chat(f, k, caret=True):
    """The conversation inside the app window, k lines of it."""
    if k >= 1:
        f.rect(24, 6, 10, 2, 'w')
    if k >= 2:
        f.rect(7, 9, 14, 1, 'O')
    if k >= 3:
        f.rect(7, 11, 10, 1, 'O')
    f.box(7, 13, 26, 3, 'g')
    if caret:
        f.put(9, 14, 'O')


# Opening: a spark at the centre stretches into a line, then into the window
# (an old TV switching on), and the chat fills in while Clawd waves hello.
def flash(f, x, y, w, h):
    f.rect(x, y, w, h, 'y' if h > 1 else 'U')
    if h > 1:
        f.box(x, y, w, h, 'U')


OPEN_SHAPES = {1: (14, 9, 12, 1), 2: (4, 9, 32, 1), 3: (4, 5, 32, 9)}


def app_open(f, t, n):
    k = t % n
    s = t % 2
    if k == 0:
        f.art(['.U.', 'UWU', '.U.'], 19, 8)
    elif k in OPEN_SHAPES:
        flash(f, *OPEN_SHAPES[k])
    elif k == 4:
        app_window(f, 4, 1, 32, 17, body='y')
    else:
        app_window(f, 4, 1, 32, 17)
        app_chat(f, min(3, (k - 4) // 2), caret=k % 2 == 0)
    if k <= 4:
        clawd(f, lookv=-1, eyes='big' if k >= 1 else 'normal')
    elif k <= 7:
        clawd(f, y=BY - (2 if k == 5 else 0), lookv=-1, eyes='happy', la='high', ra='high',
              legs=(1, 1, 1, 1) if k == 5 else (0, 0, 0, 0))
        P.sparkles(f, k, 4, [(3, 2), (36, 3), (2, 19), (37, 18)])
    else:
        clawd(f, y=BY + (1 if k % 4 == 0 else 0), eyes='happy' if k < 16 else 'normal',
              la='wave' if s else 'high', lookv=0 if k < 16 else -1)


add('cc_app_open', 'Claude 启动', 'The Claude app opens', app_open, n=20,
    dur=[300, 90, 90, 90, 120, 300, 200, 200] + [220] * 11 + [500])


# Closing: Clawd waves the app off, the window collapses like a TV switching off,
# and Clawd stretches: the work is done for now.
def app_close(f, t, n):
    k = t % n
    s = t % 2
    if k <= 3:
        app_window(f, 4, 1, 32, 17)
        app_chat(f, 3, caret=s == 0)
    elif k == 4:
        app_window(f, 4, 1, 32, 17, body='y')
    elif k <= 7:
        flash(f, *OPEN_SHAPES[8 - k])
    elif k == 8:
        f.art(['.U.', 'UWU', '.U.'], 19, 8)
    elif k == 9:
        f.put(20, 9, 'U')
    if k <= 3:
        clawd(f, eyes='happy', la='wave' if s else 'high', lookv=-1)
    elif k <= 9:
        clawd(f, eyes='normal' if k < 8 else 'big', lookv=-1)
    elif k <= 13:
        clawd(f, y=BY - 2, h=14, eyes='closed', la='up', ra='up')
    else:
        clawd(f, y=BY + (1 if k % 3 == 0 else 0), eyes='closed' if k < 18 else 'happy')
        if k >= 15:
            f.art(P.NOTE, 30, 14 - (k - 15))


add('cc_app_close', 'Claude 退出', 'The Claude app closes', app_close, n=20,
    dur=[260, 260, 260, 260, 120, 90, 90, 90, 160, 300] + [250] * 4 + [250] * 5 + [500])

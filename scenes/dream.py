"""Dreaming: what the pet plays while it goes over its memory in its sleep (memory.rs).

Two poses, the ones it sleeps in: tucked in bed at night (life_bed_sleep) and dozing over
a book at a nap (read_doze), each copied here since importing those modules would
register their scenes again. Where those have Zzz, a thought bubble shows the dream, a
different one in each animation. Everything in the bubble stays inside it.
"""
from engine import Canvas, BY, add, clawd, mini
import props as P

STAR = ['.U.', 'UWU', '.U.']
TWINKLE = ['U']
HEART5 = ['.Z.Z.', 'ZZZZZ', 'ZZZZZ', '.ZZZ.', '..Z..']
CLOUD = ['.SS.', 'SSSS']
FLYER = [  # wings up, wings down
    ['G.....G', 'GG...GG', '.OOOOO.', '.OKOKO.', '.OOOOO.', '..O.O..'],
    ['.......', '.OOOOO.', 'GOKOKOG', 'GOOOOOG', '..O.O..', '.......'],
]


# --------------------------------------------------------------------------- poses
def bed(f, k):
    """life_bed_sleep without the Zzz: tucked in, breathing. Returns the bubble box."""
    f.rrect(5, 14, 30, 22, 'N'); f.rect(6, 15, 28, 1, 'n'); f.rect(5, 18, 30, 1, 'n')
    f.rrect(9, 20, 22, 6, 'W'); f.rect(9, 25, 22, 1, 'G'); f.put(9, 21, 'G'); f.put(30, 21, 'G')
    breath = 1 if (k // 2) % 2 else 0
    clawd(f, x=12, y=18 - breath, eyes='closed', leg_h=0)
    top = 27 - breath
    f.rect(6, top, 28, 35 - top, 'B'); f.rect(6, top, 28, 1, 'W'); f.rect(6, top + 1, 28, 1, 'G')
    for (sx, sy) in ((9, 3), (16, 5), (23, 3), (30, 5), (12, 7), (27, 7)):
        if top + sy < 35:
            f.art(['.S.', 'SWS', '.S.'] if (sx + k // 4) % 2 else ['S'], sx - 1, top + sy - 1)
    f.rect(5, 35, 2, 1, 'n'); f.rect(33, 35, 2, 1, 'n')
    return bubble(f, 19, 1, 20, 10)


def doze(f, k):
    """read_doze nodded off for good: eyes shut over the book. Returns the bubble box."""
    info = clawd(f, eyes='closed', y=BY + 1, h=11, top=True)
    P.face(f, info, 'readers')
    P.item(f, (info['rh'][0], info['rh'][1] + 2), 'book', art=(['bbbbb', 'bwwwb', 'bbbbb', 'bwwwb', 'bbbbb'], 0, 2))
    return bubble(f, 19, 4, 20, 11)


def bubble(f, x, y, w, h):
    """The thought bubble, its trail running down to the head. Returns the inside (x0, y0, x1, y1)."""
    T = Canvas(f.w, f.h)
    P.thought(T, x, y, w, h, c='W')
    f.blit(T.outline('G'))
    return x + 1, y + 1, x + w - 2, y + h - 2


def inside(f, box, draw):
    """Draws `draw(L)` on a layer and copies only what falls inside the bubble."""
    L = Canvas(f.w, f.h)
    draw(L)
    x0, y0, x1, y1 = box
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if L.px[y][x] is not None:
                f.px[y][x] = L.px[y][x]


# --------------------------------------------------------------------------- dreams
def moon_stars(L, box, k):
    x0, y0, x1, y1 = box
    P.moon(L, x0 + 2, y0 + 1)
    for i, (sx, sy) in enumerate(((x0 + 10, y0 + 1), (x0 + 14, y0 + 4), (x0 + 9, y0 + 6))):
        if (k // 2 + i) % 3:
            L.art(STAR, sx - 1, sy - 1)
        else:
            L.art(TWINKLE, sx, sy)


def code(L, box, k):
    """A little terminal: a line types itself out, then a green tick."""
    x0, y0, x1, y1 = box
    L.rect(x0 + 1, y0, 15, 8, 'k')
    L.rect(x0 + 1, y0, 15, 1, 'g')
    L.put(x0 + 2, y0, 'R'); L.put(x0 + 4, y0, 'U'); L.put(x0 + 6, y0, 'E')
    L.put(x0 + 2, y0 + 2, 'E'); L.put(x0 + 3, y0 + 3, 'E'); L.put(x0 + 2, y0 + 4, 'E')
    typed = min(k, 10)
    L.rect(x0 + 5, y0 + 3, typed, 1, 'W')
    if k < 11:
        if k % 2 == 0:
            L.rect(x0 + 5 + typed, y0 + 2, 1, 3, 'C')
    else:
        L.art(['....E', '...E.', 'E.E..', '.E...'], x0 + 6, y0 + 4)


def hearts(L, box, k):
    """A heart beats in the middle; small ones float up beside it."""
    x0, y0, x1, y1 = box
    cx = x0 + 9
    a = P.HEART_BIG if k % 4 < 2 else HEART5
    L.art(a, cx - len(a[0]) // 2, y0 + (1 if len(a) > 5 else 2))
    for i, sx in enumerate((x0 + 2, x0 + 15)):
        p = ((k + i * 8) % 16) / 16
        L.art(P.HEART, sx, int(y1 - 2 - p * 8), cmap={'Z': 'r'})


def food(L, box, k):
    """An ice cream and a doughnut take turns, with a sparkle."""
    x0, y0, x1, y1 = box
    name = 'icecream' if k < 8 else 'donut'
    art = P.ITEMS[name][0]
    L.art(art, x0 + 6, y0 + 1)
    sx, sy = (x0 + 14, y0 + 1) if k % 4 < 2 else (x0 + 2, y0 + 5)
    L.art(P.SPARK, sx, sy)


def fly(L, box, k):
    """A tiny winged Clawd flies across the sky, past clouds."""
    x0, y0, x1, y1 = box
    L.art(CLOUD, x0 + 2 + (k // 4) % 2, y0 + 6)
    L.art(CLOUD, x0 + 12 - (k // 4) % 2, y0 + 1)
    x = x0 - 3 + k * 20 // 16
    y = y0 + 2 + (0 if k % 4 < 2 else 1)
    L.art(FLYER[k % 2], x, y)


def castle(L, box, k):
    """The story in the book: a little castle, its flag flapping."""
    x0, y0, x1, y1 = box
    bx, by = x0 + 4, y0 + 3
    L.rect(bx, by + 2, 10, 5, 'G')
    for i in range(0, 10, 3):
        L.rect(bx + i, by + 1, 2, 1, 'G')
    L.rect(bx + 4, by + 4, 2, 3, 'n')
    L.rect(bx + 1, by + 3, 1, 1, 'b'); L.rect(bx + 8, by + 3, 1, 1, 'b')
    L.rect(bx + 5, by - 3, 1, 4, 'g')
    L.art(['RR.', 'RRR'] if k % 4 < 2 else ['RRR', 'RR.'], bx + 6, by - 3)
    if k % 8 < 4:
        L.art(TWINKLE, x0 + 16, y0 + 1)


def fishes(L, box, k):
    """Two little fish sway in the water, bubbles rising."""
    x0, y0, x1, y1 = box
    L.rect(x0, y1, x1 - x0 + 1, 1, 'S')
    sway = (0, 1, 2, 1)[k // 4]
    fish = P.ITEMS['fish'][0]
    L.art(fish, x0 + 9 + sway, y0 + 1)
    L.art(fish, x0 + 3 - sway, y0 + 5, cmap={'C': 'Y'})
    for i, bx in enumerate((x0 + 2, x0 + 15)):
        p = ((k + i * 6) % 16) / 16
        L.put(bx, int(y1 - 1 - p * 7), 'S')


def tea(L, box, k):
    """Afternoon tea: a mug of tea with steam and a slice of cake."""
    x0, y0, x1, y1 = box
    L.art(P.ITEMS['mug'][0], x0 + 3, y0 + 3, cmap={'G': 'B', 'W': 'B'})
    for i, sx in enumerate((x0 + 4, x0 + 6)):
        dy = (k // 2 + i * 2) % 4
        L.put(sx + (dy % 2), y0 + 3 - dy, 'G')
    L.art(['....Z', '..TTT', 'TTTTT', 'ZZZZZ', 'TTTTT', 'NNNNN'], x0 + 12, y0 + 3)


# --------------------------------------------------------------------------- scenes
def night(dream):
    def scene(f, t, n):
        k = t % 16
        box = bed(f, k)
        inside(f, box, lambda L: dream(L, box, k))
    return scene


def nap(dream):
    def scene(f, t, n):
        k = t % 16
        box = doze(f, k)
        inside(f, box, lambda L: dream(L, box, k))
    return scene


add('dream_night_stars', '梦见星星月亮', 'Dreaming of the moon', night(moon_stars), n=16, dur=200)
add('dream_night_code', '梦里写代码', 'Coding in a dream', night(code), n=16, dur=200)
add('dream_night_hearts', '梦见小爱心', 'Dreaming of hearts', night(hearts), n=16, dur=200)
add('dream_night_food', '梦见好吃的', 'Dreaming of treats', night(food), n=16, dur=200)
add('dream_night_fly', '梦见飞起来', 'Flying in a dream', night(fly), n=16, dur=200)
add('dream_nap_castle', '梦见书里的城堡', 'Dreaming of the story', nap(castle), n=16, dur=200)
add('dream_nap_fish', '梦见小鱼', 'Dreaming of fish', nap(fishes), n=16, dur=200)
add('dream_nap_tea', '梦见下午茶', 'Dreaming of afternoon tea', nap(tea), n=16, dur=200)

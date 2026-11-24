"""Edge peek: the pet tucked behind a side of the screen, only its near half showing.

Drawn for the right edge (`_r`: the crab is past the right side of the screen and peeks
in to the left); the `_l` versions are their mirror images. The screen edge cuts the
sprite at a column pet.js knows (PEEK_CUT): tucked in, the left arm and the left eye
show; hovered, the pet slides out until both eyes do. Everything drawn here stays left
of where it is cut when tucked in, except what only shows once it slides out.
"""
from engine import Canvas, BX, BY, add, clawd

Z = ['KKK', '..K', '.K.', 'KKK']


def mirrored(fn):
    """The left edge's version. Letters drawn by `fn` through `zs` still read right."""
    def left(f, t, n):
        L = Canvas(f.w, f.h)
        marks = []
        fn(L, t, n, marks)
        f.blit(L.flipx())
        for glyph, x, y, c in marks:
            f.art(glyph, f.w - x - len(glyph[0]), y, cmap={'K': c})
    return left


def right(fn):
    def draw(f, t, n):
        marks = []
        fn(f, t, n, marks)
        for glyph, x, y, c in marks:
            f.art(glyph, x, y, cmap={'K': c})
    return draw


def peek(f, t, n, marks):
    """Tucked in: looks in along the screen, glances at you now and then, leaning out."""
    k = t % n
    dip = 1 if k in (2, 3, 4, 13, 14) else 0
    glance = 8 <= k <= 11
    clawd(f, x=BX - (1 if glance else 0), y=BY + dip, h=12 - dip, look=0 if glance else -1,
          eyes='blink' if k in (6, 15) else 'normal', la='short')


def peek_hi(f, t, n, marks):
    """Hovered: slid out a bit, waving."""
    k = t % n
    up = (k // 2) % 2 == 0
    clawd(f, x=BX - 1, y=BY - (1 if up else 0), look=-1, eyes='happy',
          la='wave' if up else 'high')


def peek_sleep(f, t, n, marks):
    """Asleep at the edge: eyes shut, a Z or two drifting up and in."""
    k = t % n
    dip = 1 if 4 <= k <= 9 else 0
    clawd(f, y=BY + dip, h=12 - dip, look=-1, eyes='closed', la='short')
    for i in range(2):
        p = ((k / n) + i / 2) % 1
        if p < 0.85:
            marks.append((Z, BX + 1 - int(p * 6), BY - 5 - int(p * 9), 'B'))


add('peek_r', '躲在右边偷看', 'Peeking from the right', right(peek), n=16, dur=[200] * 16)
add('peek_l', '躲在左边偷看', 'Peeking from the left', mirrored(peek), n=16, dur=[200] * 16)
add('peek_hi_r', '从右边探出来打招呼', 'Waving from the right', right(peek_hi), n=8, dur=[150] * 8)
add('peek_hi_l', '从左边探出来打招呼', 'Waving from the left', mirrored(peek_hi), n=8, dur=[150] * 8)
add('peek_sleep_r', '在右边睡着了', 'Asleep at the right', right(peek_sleep), n=12, dur=[260] * 12)
add('peek_sleep_l', '在左边睡着了', 'Asleep at the left', mirrored(peek_sleep), n=12, dur=[260] * 12)

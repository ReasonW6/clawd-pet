"""Eye-follow: the plain rest pose looking towards the mouse cursor, one animation per
direction (gaze_c straight at you, gaze_n up, gaze_ne ... gaze_nw clockwise). The pet
swaps between them as the cursor moves round it (pet.js), so all nine share one loop:
the same breathing and the same blink on the same frame, and only the eyes and a slight
lean differ. Looking sideways the eyes shift two pixels and the whole crab a pixel that
way; looking up the head rises a pixel, looking down it dips and shows its top face.
"""
from engine import BX, BY, add, clawd

# (look, lookv) per direction; the lean follows look.
DIRS = {
    'c': (0, 0),
    'n': (0, -1),
    'ne': (1, -1),
    'e': (1, 0),
    'se': (1, 1),
    's': (0, 1),
    'sw': (-1, 1),
    'w': (-1, 0),
    'nw': (-1, -1),
}
NAMES = {
    'c': ('看着你', 'Looking at you'),
    'n': ('往上看', 'Looking up'),
    'ne': ('往右上看', 'Looking up right'),
    'e': ('往右看', 'Looking right'),
    'se': ('往右下看', 'Looking down right'),
    's': ('往下看', 'Looking down'),
    'sw': ('往左下看', 'Looking down left'),
    'w': ('往左看', 'Looking left'),
    'nw': ('往左上看', 'Looking up left'),
}
N = 8
BLINK = 5
# Breathing: the body top dips a pixel on these frames.
DIP = {2, 3, 4}


def gaze(dx, dy):
    def fn(f, t, n):
        k = t % n
        dip = 1 if k in DIP else 0
        # Up: the head rises a pixel. Down: it dips towards you and shows its top face.
        y, h = BY + dip, 12 - dip
        if dy < 0:
            y, h = y - 1, h + 1
        elif dy > 0:
            y, h = y + 1, h - 1
        # It shifts its weight a pixel towards where it looks.
        clawd(f, x=BX + dx, y=y, h=h, look=2 * dx, lookv=dy, top=dy > 0,
              eyes='blink' if k == BLINK else 'normal')
    return fn


for d, (look, lookv) in DIRS.items():
    zh, en = NAMES[d]
    add(f'gaze_{d}', zh, en, gaze(look, lookv), n=N, dur=[220] * N)

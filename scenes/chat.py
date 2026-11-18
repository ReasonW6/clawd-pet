"""Chatting with the user in the bubbles above the pet. All at the desk of desk_typing
(video.py), which plays while a reply is being written, so the pet stays in one place
as it listens, ponders and looks at the screen.

Nothing is drawn above the monitor's top edge (row 19), the top of desk_typing: the
bubbles sit just above the drawing and don't move when the pet changes between these.
"""
from engine import BY, add, clawd, beats
import props as P


# --------------------------------------------------------------------------- the desk
# desk_bg / chair from video.py (importing that module would register its scenes again).
SCREEN = (32, 20, 6, 5)  # inside of the monitor


def desk(f):
    f.rect(27, 28, 13, 1, 'G'); f.rect(28, 29, 1, 8, 'g'); f.rect(38, 29, 1, 8, 'g')
    f.rect(31, 19, 8, 7, 'k'); f.rect(32, 20, 6, 5, 'b'); f.rect(34, 26, 2, 2, 'k')
    f.rect(26, 27, 5, 1, 'k')


def chair(f, x=9):
    f.rect(x, 34, 18, 1, 'g'); f.rect(x + 8, 35, 2, 3, 'g'); f.rect(x + 4, 38, 10, 1, 'g')
    f.rect(x, 22, 2, 12, 'g')


def sit(f, **kw):
    """Clawd on the chair."""
    return clawd(f, x=10, y=kw.pop('y', BY + 1), leg_h=2, **kw)


# --------------------------------------------------------------------------- listening
def listen(f, t, n):
    """Turned round on the chair, looking up at what the user is typing above it; a nod
    now and then. A text cursor blinks on the monitor behind."""
    desk(f)
    chair(f)
    k = t % n
    nod = k in (6, 7, 12)
    sit(f, view='qr', tilt=0 if nod else 1, lookv=0 if nod else -1, y=BY + 1 + (1 if nod else 0),
        eyes='blink' if k == 10 else 'happy' if nod else 'normal')
    if (t // 3) % 2 == 0:
        f.rect(33, 21, 1, 3, 'C')


# --------------------------------------------------------------------------- thinking
def ponder(f, t, n):
    """Claw on the chin, eyes up, while dots fill in on the monitor one by one."""
    desk(f)
    chair(f)
    k = t % n
    sit(f, view='qr', tilt=1, ra='chin', look=-1 if k >= 8 else 0, lookv=-1,
        eyes='blink' if k in (5, 13) else 'normal')
    for i in range((t // 2) % 4):
        f.put(33 + i * 2, 22, 'W')


# --------------------------------------------------------------------------- the screen
FLASH = [(-3, 0), (3, 0), (0, -3), (0, 3), (-2, -2), (2, -2), (-2, 2), (2, 2)]


def snap(f, t, n):
    """Turns round with a camera, aims, flash! The shot comes up on the monitor."""
    desk(f)
    chair(f)
    k = t % n
    x, y, w, h = SCREEN
    if k < 3:  # still at the keyboard
        sit(f, view='q2r', ra='side')
        f.rect(26, 26 - k % 2, 3, 1, 'O')
        f.rect(33, 21, (k + 2) % 5 + 1, 1, 'C'); f.rect(33, 23, 3, 1, 'C')
        return
    aim = 5 <= k <= 9
    raised = 4 <= k <= 12
    # Aiming: the far eye shut, the near one at the viewfinder.
    info = sit(f, view='qr', ra='high' if raised else 'side', tilt=1 if aim else 0,
               eyes='closed' if aim else 'happy' if k >= 10 else 'normal', eyes_r='normal' if aim else None)
    if raised:
        cx, cy = info['rh']
        P.item(f, (cx - 1, cy - 1), 'camera')
        lens = (int(cx) + 6, int(cy) - 1)
        if k in (8, 9):
            for i, (dx, dy) in enumerate(FLASH):
                if k == 8 or i < 4:
                    f.put(lens[0] + dx, lens[1] + dy, 'W' if k == 8 else 'U')
    if k == 8:
        f.rect(x, y, w, h, 'W')
    elif k >= 9:
        # The shot: a little landscape in a white frame.
        f.rect(x, y, w, h, 'W')
        f.rect(x + 1, y + 1, w - 2, h - 2, 'S')
        f.rect(x + 1, y + 3, w - 2, 1, 'E')
        f.put(x + 4, y + 1, 'U')


add('chat_listen', '听你说', 'Listening to you', listen, n=16, dur=160)
add('chat_ponder', '琢磨怎么回', 'Thinking of a reply', ponder, n=16, dur=150)
add('chat_snap', '看一眼屏幕', 'A look at your screen', snap, n=16,
    dur=beats(16, 110, {(5, 6, 7): 160, 8: 90, 9: 200, (10, 11, 12, 13, 14): 220, 15: 300}))

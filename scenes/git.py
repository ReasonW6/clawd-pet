"""Git commands, one animation each.

Shared look: a commit is a 3x3 square on its branch line, main is blue (B), a feature
branch purple (P), a merge commit green (E); the remote is a white cloud; a batch of
changes is a cardboard box.
"""
import math
from engine import Canvas, GROUND, BX, BY, add, clawd, rng
import props as P

MAIN, FEAT, MERGE = 'B', 'P', 'E'


def LG(s):
    """Alternating walk legs."""
    return (1, 0, 1, 0) if s else (0, 1, 0, 1)


def lerp(a, b, p):
    return a + (b - a) * p


# --------------------------------------------------------------------------- shared art
def node(f, x, y, c, glow=False, ghost=False):
    """A commit, centred on (x, y)."""
    if ghost:
        f.box(x - 1, y - 1, 3, 3, 'G')
        return
    f.rect(x - 1, y - 1, 3, 3, c)
    if glow:
        f.box(x - 2, y - 2, 5, 5, 'U')


def chain(f, xs, y, c, glow=None):
    """Commits at xs on a horizontal branch line; glow = index of a fresh one."""
    if len(xs) > 1:
        f.rect(xs[0], y, xs[-1] - xs[0], 1, c)
    for i, x in enumerate(xs):
        node(f, x, y, c, glow=(i == glow))


def cloud(f, x, y, w, h=8):
    """The remote: a white cloud with a grey edge, so it reads on white and on dark."""
    L = Canvas()
    L.rrect(x, y + 2, w, h - 2, 'w')
    L.rrect(x + 3, y, w // 2 - 2, 4, 'w')
    L.rrect(x + w // 2, y + 1, w // 2 - 3, 3, 'w')
    f.blit(L.outline('G'))


PAPER = ['GGGG.', 'GWWGG', 'GBBWG', 'GWWWG', 'GBBWG', 'GGGGG']


def paper(f, x, y):
    f.art(PAPER, int(x), int(y))


def carton(f, x, y, w=10, h=7, flaps=0, tape=0.0, mark=None, peek=0):
    """Cardboard box, top-left (x, y). flaps: 0 open, 1 half shut, 2 shut.
    tape: 0..1 of the strip down the front. peek: papers showing over the rim."""
    x, y = int(x), int(y)
    for i in range(peek):
        f.rect(x + 1 + i * 3, y - 2, 3, 2, 'W')
        f.put(x + 1 + i * 3, y - 2, 'G')
    if flaps == 0:
        f.rect(x - 2, y - 2, w // 2, 1, 'n'); f.rect(x - 1, y - 1, w // 2, 1, 'n')
        f.rect(x + w // 2 + 2, y - 2, w // 2, 1, 'n'); f.rect(x + w // 2 + 1, y - 1, w // 2, 1, 'n')
    elif flaps == 1:
        f.rect(x, y - 2, w // 2 - 1, 1, 'n'); f.rect(x + w // 2 + 1, y - 2, w // 2 - 1, 1, 'n')
        f.rect(x, y - 1, w, 1, 'n')
    else:
        f.rect(x, y - 1, w, 1, 'n')
    f.rect(x, y, w, h, 'N')
    f.rect(x, y, w, 1, 'n')
    if tape:
        f.rect(x + w // 2 - 1, y - 1, 2, 1 + int(round(h * tape)), 'y')
    if mark:
        f.text_c(mark, x + w / 2, y + h - 6, 'R')


def plus(f, x, y, c='E'):
    f.art(['.C.', 'CCC', '.C.'], int(x), int(y), cmap={'C': c})


# --------------------------------------------------------------------------- git init: plant the flag
# A git-red flag that says GIT: "a repository starts here".
def flag(f, px, top, t, wave=True):
    """Pole at column px from row top, 26 long; cloth to the right. Only the tail flutters,
    so the lettering stays readable."""
    f.rect(px, top, 1, 26, 'g')
    f.put(px, top - 1, 'Y')
    f.rect(px + 1, top, 13, 7, 'R')
    f.rect(px + 14, top + (1 if wave and t % 2 else 0), 2, 7, 'R')
    f.text('GIT', px + 2, top + 1, 'W')


def git_init(f, t, n):
    k = t % n
    if k <= 4:  # carry it, crouch, jump
        y = {0: BY, 1: BY, 2: BY + 2, 3: BY - 5, 4: BY - 2}[k]
        pole_top = {0: 4, 1: 4, 2: 6, 3: -1, 4: 2}[k]
        flag(f, 10, pole_top, k, wave=k < 2)
        if k == 2:
            clawd(f, x=13, y=y, w=18, h=10, la='up', eyes='focus')
        elif k == 3:
            clawd(f, x=15, y=y, w=14, h=14, la='up', eyes='focus', legs=(1, 1, 1, 1))
        else:
            clawd(f, x=14, y=y, la='up', eyes='focus' if k else 'normal', lookv=-1 if k < 2 else 0)
        return
    flag(f, 10, 10, k, wave=k >= 7)
    if k == 5:  # thunk: driven into the ground
        clawd(f, x=13, y=BY + 2, w=18, h=10, la='up', eyes='squint')
        P.dust(f, 5, 36, 0.1); P.dust(f, 13, 36, 0.1, flip=True)
        return
    if k == 6:
        clawd(f, x=14, la='mid', eyes='big', look=-1)
        P.dust(f, 4, 36, 0.5); P.dust(f, 14, 36, 0.5, flip=True)
        return
    if k in (7, 8):
        s = k % 2
        clawd(f, x=15 + (k - 7) * 2, y=BY + s, legs=LG(s), eyes='normal', look=-1)
        return
    if k <= 13:  # proud
        j = k - 9
        up = j % 2 == 0
        clawd(f, x=18, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high',
              eyes='happy')
        P.sparkles(f, k, 4, [(5, 9), (28, 8), (4, 20), (28, 18)])
        return
    clawd(f, x=18, y=BY + (1 if k % 2 else 0), h=12 - (k % 2), eyes='closed', look=-1)


add('git_init', 'git init：插旗开新仓库', 'git init: plant the flag', git_init, n=18,
    dur=[220, 160, 260, 100, 80, 380, 220, 110, 110, 150, 150, 150, 150, 150, 200, 200, 200, 500])


# --------------------------------------------------------------------------- git clone: copy the remote down
def git_clone(f, t, n):
    k = t % n
    cloud(f, 1, 1, 22, 9)
    remote = [7, 12, 17]
    chain(f, remote, 6, MAIN)
    local = [3, 8, 13]
    done = 0 if k < 2 else min(3, (k - 2) // 5 + (1 if (k - 2) % 5 == 4 else 0))
    copying = 2 <= k < 17 and (k - 2) // 5 < 3
    i, s = ((k - 2) // 5, (k - 2) % 5) if copying else (None, None)
    shown = local[:done]
    if len(shown) > 1:
        f.rect(shown[0], 29, shown[-1] - shown[0], 1, MAIN)
    for j, x in enumerate(shown):
        node(f, x, 29, MAIN, glow=(copying and j == i and s == 4) or (k == 17 and j == 2))
    if copying:
        sx, dx = remote[i], local[i]
        f.box(sx - 2, 4, 5, 5, 'U')
        if s < 4:
            for d in range(3):  # dots streaming down from the cloud
                p = ((s + d / 3) / 4)
                yy = int(lerp(12, 26, p))
                xx = int(round(lerp(sx, dx, p)))
                f.rect(xx, yy, 1, 2, 'C')
        if s == 3:
            node(f, dx, 29, MAIN, ghost=True)
    if k >= 17:
        P.check(f, 5, 20)
        up = k % 2 == 1
        clawd(f, x=21, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
        return
    clawd(f, x=21, eyes='big' if copying else 'normal', look=-1, lookv=-1 if copying and s < 2 else 0)


add('git_clone', 'git clone：把远程仓库复印下来', 'git clone: copy it all down', git_clone, n=20,
    dur=[200, 160] + [110, 110, 110, 160, 220] * 3 + [380, 160, 300])


# --------------------------------------------------------------------------- git add: toss files into the box
def git_add(f, t, n):
    k = t % n
    toss, s = (k // 5, k % 5) if k < 15 else (3, None)
    landed = toss if k < 15 else 3
    pile = 3 - toss - (1 if s is not None and s > 0 else 0)
    for i in range(pile):
        paper(f, 1, 29 - i * 3)
    bx, by = 29, 29
    # papers already in the box stick up over the rim (drawn before the box front)
    carton(f, bx, by, flaps=0, peek=landed if k < 15 or True else 3)
    look = -1
    la = 'low'
    if s is not None and s > 0:
        p = s / 4
        x = lerp(2, 31, p)
        y = 27 - 21 * math.sin(math.pi * p)
        if s < 4:
            paper(f, x, y)
        else:
            plus(f, 32, 21)
        la = ['low', 'mid', 'up', 'up', 'side'][s]
        look = -1 if s < 2 else 1
    if k >= 15:
        j = k - 15
        clawd(f, x=11, y=BY - (1 if j % 2 == 0 else 0), la='high', ra='high', eyes='happy')
        if j < 2:
            plus(f, 32, 20 - j)
        return
    clawd(f, x=11, la=la, eyes='focus', look=look)


add('git_add', 'git add：文件一张张装进箱', 'git add: into the box', git_add, n=20,
    dur=[200, 100, 100, 100, 220] * 3 + [180, 180, 180, 180, 400])


# --------------------------------------------------------------------------- git commit: seal, stamp, send up
STAMP = ['.nnn.', '.nnn.', '..n..', '..n..', 'NNNNN', 'RRRRR']


def git_commit(f, t, n):
    k = t % n
    hist = [6, 14]
    new_on_chain = k >= 11
    chain(f, hist + ([22] if new_on_chain else []), 4, MAIN, glow=2 if 11 <= k <= 14 else None)
    cx = 4
    bx, by = 24, 26
    if k <= 8:
        flaps = 0 if k < 2 else 1 if k == 2 else 2
        tape = 0 if k < 4 else 0.5 if k == 4 else 1
        mark = 'A7F' if k >= 8 else None
        squash = 1 if k == 7 else 0
        carton(f, bx, by + squash, w=13, h=10 - squash, flaps=flaps, tape=tape, mark=mark, peek=3 if k < 2 else 0)
        if k == 6:  # wind up
            info = clawd(f, x=cx, ra='up', eyes='focus', look=1)
            f.art(STAMP, int(info['rh'][0]) - 2, int(info['rh'][1]) - 6)
        elif k == 7:  # stamp!
            clawd(f, x=cx, y=BY + 1, h=11, ra='reach', eyes='squint', look=1)
            f.art(STAMP, 28, by - 5)
            f.art(['L.', '.L'], 25, by - 4); f.art(['.L', 'L.'], 34, by - 4)
        elif k == 8:
            info = clawd(f, x=cx, ra='up', eyes='big', look=1)
            f.art(STAMP, int(info['rh'][0]) - 2, int(info['rh'][1]) - 6)
        else:
            clawd(f, x=cx, ra='reach' if 2 <= k <= 5 else 'side', eyes='focus' if 2 <= k <= 5 else 'normal', look=1)
        return
    if k <= 10:  # the sealed box shrinks and flies up onto the history line
        p = (k - 8) / 3
        w = int(lerp(13, 4, p)); h = int(lerp(10, 3, p))
        x = lerp(bx, 21, p); y = lerp(by, 6, p)
        f.rect(int(x), int(y), w, h, 'N')
        f.rect(int(x), int(y), w, 1, 'n')
        for d in range(1, 3):
            f.put(int(x + w / 2), int(y + h + d * 2), 'L')
        clawd(f, x=cx, eyes='big', lookv=-1, look=1)
        return
    j = k - 11
    if j < 6:
        up = j % 2 == 0
        clawd(f, x=cx + 4, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
        P.sparkles(f, k, 4, [(26, 2), (18, 8), (27, 9)])
        return
    clawd(f, x=cx + 4, y=BY + (j % 2), h=12 - (j % 2), eyes='closed')


add('git_commit', 'git commit：封箱盖章入历史', 'git commit: seal, stamp, file it', git_commit, n=21,
    dur=[200, 160, 90, 180, 110, 200, 260, 380, 300, 100, 100, 380, 150, 150, 150, 150, 150, 200, 200, 200, 400])


# --------------------------------------------------------------------------- git push: toss it up to the remote
def git_push(f, t, n):
    k = t % n
    remote = [20, 25] + ([30] if k >= 5 else [])
    cx = 10
    box_y = {0: 11, 1: 11, 2: 13, 3: 6, 4: 1}.get(k)
    if box_y is not None:
        carton(f, 24, box_y, w=8, h=6, flaps=2, tape=1)
        if k >= 3:
            for d in range(1, 4):
                f.put(28, box_y + 6 + d * 2, 'L')
    puff = k == 5
    cloud(f, 13 - puff, 0, 26 + 2 * puff, 9 + puff)
    chain(f, remote, 5, MAIN, glow=2 if 5 <= k <= 8 else None)
    if k <= 1:
        clawd(f, x=cx, ra='up', eyes='focus', lookv=-1, look=1)
    elif k == 2:
        clawd(f, x=cx - 1, y=BY + 2, w=18, h=10, ra='up', eyes='focus')
    elif k == 3:
        clawd(f, x=cx + 1, y=BY - 5, w=14, h=14, la='high', ra='up', legs=(1, 1, 1, 1), eyes='big', lookv=-1)
    elif k == 4:
        clawd(f, x=cx, y=BY - 2, la='high', ra='up', legs=(1, 1, 1, 1), eyes='big', lookv=-1)
    elif k == 5:
        clawd(f, x=cx - 1, y=BY + 2, w=18, h=10, eyes='squint')
        P.dust(f, cx - 3, 36, 0.2); P.dust(f, cx + 18, 36, 0.2, flip=True)
    elif k <= 12:
        up = k % 2 == 0
        clawd(f, x=cx, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
        P.sparkles(f, k, 4, [(12, 4), (36, 11), (30, 1)])
    else:
        clawd(f, x=cx, y=BY + (k % 2), h=12 - (k % 2), eyes='closed')


add('git_push', 'git push：抛上云端', 'git push: up to the remote', git_push, n=18,
    dur=[220, 160, 260, 100, 90, 380, 150, 150, 150, 150, 150, 150, 150, 200, 200, 200, 200, 400])


# --------------------------------------------------------------------------- git pull: haul it down on a rope
def git_pull(f, t, n):
    k = t % n
    pulls = 12
    if k <= pulls:
        box_y = int(lerp(1, 29, k / pulls))
    else:
        box_y = 29
    landed = k > pulls
    opened = k >= pulls + 3
    bx = 5
    carton(f, bx, box_y, w=9, h=7, flaps=0 if opened else 2, tape=0 if opened else 1)
    cloud(f, 0, 0, 22, 9)
    # Clawd hauls, leaning back
    L = Canvas()
    cx = 22
    if not landed:
        s = k % 2
        lean = 0.06 if s else 0.12
        info = clawd(L, x=cx, la='high' if s else 'mid', ra='mid' if s else 'high', eyes='focus', look=-1,
                     legs=(0, 0, 0, 0))
        hx, hy = info['lh']
        hx += round((36 - hy) * lean)
        f.line(bx + 4, box_y - 1, hx, hy, 'N')
        f.blit(L.shear(lean))
        f.art(P.SWEAT, cx + 15 + 2, 18 + s)
        return
    j = k - pulls - 1
    if j == 0:  # thud
        clawd(L, x=cx, y=BY + 2, w=18, h=10, eyes='squint', la='mid')
        f.blit(L)
        P.dust(f, bx - 3, 36, 0.2); P.dust(f, bx + 9, 36, 0.2, flip=True)
        return
    if opened:
        q = j - 2
        if q >= 0:
            yy = max(20, 27 - q * 3)
            node(f, bx + 4, yy, MAIN, glow=True)
            if q >= 2:
                P.sparkles(f, k, 4, [(bx + 1, yy - 3), (bx + 8, yy - 1)])
        up = j % 2 == 1
        clawd(L, x=cx, y=BY - (1 if up and q >= 2 else 0), la='up' if up and q >= 2 else 'high',
              ra='up' if up and q >= 2 else 'high', eyes='happy', look=-1)
    else:
        clawd(L, x=cx, eyes='big', look=-1)
    f.blit(L)


add('git_pull', 'git pull：拽绳子拉下来', 'git pull: haul it down', git_pull, n=22,
    dur=[200] + [110] * 12 + [380, 200, 160, 200, 160, 160, 160, 160, 400])


# --------------------------------------------------------------------------- git branch: grow a new one
LEAF = ['.EE', 'EEe', 'Ee.']


def git_branch(f, t, n):
    k = t % n
    f.rect(0, 6, 40, 1, MAIN)
    for x in (4, 12, 20, 28, 36):
        node(f, x, 6, MAIN, glow=(x == 12 and 3 <= k <= 4))
    g = 0 if k < 4 else min(1, (k - 3) / 8)
    # path: down-right from the commit at 12, then along y=13
    pts = [(13 + i, 7 + i) for i in range(6)] + [(19 + i, 13) for i in range(16)]
    m = int(round(g * len(pts)))
    for (x, y) in pts[:m]:
        f.put(x, y, FEAT)
    if 0 < m < len(pts):
        tx, ty = pts[m - 1]
        f.art(LEAF, tx, ty - 3)
    for i, (x, need) in enumerate(((24, 11), (32, 19))):
        if m >= need:
            node(f, x, 13, FEAT, glow=(m == need or (k == 12 and i == 1)))
    if k >= 12:
        f.text_c('DEV', 32, 16, FEAT)
    if k == 2:
        info = clawd(f, x=6, la='mid', eyes='normal', lookv=-1)
        P.hold(f, info, 'wand', side='l')
    elif k <= 11:
        info = clawd(f, x=6, la='up' if k >= 3 else 'side', eyes='focus' if k >= 3 else 'normal', lookv=-1,
                     view='front')
        if k >= 3:
            P.hold(f, info, 'wand', side='l')
            P.sparkles(f, k, 4, [(9, 13), (14, 10)])
    else:
        up = k % 2 == 0
        clawd(f, x=6, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')


add('git_branch', 'git branch：长出一根新分支', 'git branch: grow a new one', git_branch, n=18,
    dur=[200, 160, 100, 220] + [100] * 8 + [380, 160, 160, 160, 160, 400])


# --------------------------------------------------------------------------- git switch: hop to the other branch
def git_switch(f, t, n):
    k = t % n
    on_dev = 10 <= k <= 20
    f.rect(2, 36, 18, 2, MAIN)
    f.rect(22, 36, 16, 2, FEAT)
    f.text_c('MAIN', 11, 3, 'G' if on_dev else MAIN)
    f.text_c('DEV', 30, 3, FEAT if on_dev else 'G')
    if not on_dev and k < 10:
        f.art(['B.B', '.B.'], 10, 9)
    if on_dev:
        f.art(['P.P', '.P.'], 29, 9)

    def hop(j, x0, x1, view):
        if j == 0:  # crouch
            clawd(f, x=x0 - 1, y=BY + 2, w=18, h=10, eyes='focus')
        elif j <= 5:
            p = j / 6
            y = BY - int(round(10 * math.sin(math.pi * p)))
            clawd(f, x=int(round(lerp(x0, x1, p))), y=y, view=view, legs=(1, 1, 1, 1),
                  la='up' if j == 3 else 'high', ra='up' if j == 3 else 'high', eyes='big')
        else:  # land
            clawd(f, x=x1 - 1, y=BY + 2, w=18, h=10, eyes='squint')
            P.dust(f, x1 - 3, 36, 0.2); P.dust(f, x1 + 18, 36, 0.2, flip=True)

    if k <= 3:
        clawd(f, x=4, y=BY + (k % 2), h=12 - (k % 2), eyes='normal', look=1 if k >= 2 else 0)
    elif k <= 10:
        hop(k - 4, 4, 21, 'qr')
    elif k <= 14:
        clawd(f, x=21, y=BY - (1 if k % 2 else 0), eyes='happy' if k <= 12 else 'normal', look=-1 if k >= 13 else 0)
    elif k <= 21:
        hop(k - 15, 21, 4, 'ql')
    else:
        clawd(f, x=4, y=BY - (1 if k % 2 else 0), eyes='happy')


add('git_switch', 'git switch：跳到另一条分支', 'git switch: hop over', git_switch, n=24,
    dur=[200, 200, 180, 180, 240, 80, 80, 90, 80, 80, 260, 160, 160, 200, 200, 240, 80, 80, 90, 80, 80, 260, 200, 300])


# --------------------------------------------------------------------------- git merge: zip the two together
def zipper(f, s, y=11):
    """Joined left of the slider at column s, the two toothed strands spreading apart to its right."""
    for x in range(40):
        if x < s:
            f.put(x, y - 1, MAIN)
            f.put(x, y, MAIN if x % 2 else FEAT)
            f.put(x, y + 1, FEAT if x % 2 else MAIN)
            f.put(x, y + 2, FEAT)
        elif x > s + 2:
            d = min(6, (x - s - 1) // 2)
            f.put(x, y - 1 - d, MAIN)
            if x % 2:
                f.put(x, y - d, MAIN)
            f.put(x, y + 2 + d, FEAT)
            if not x % 2:
                f.put(x, y + 1 + d, FEAT)
    f.rect(s, y - 2, 3, 6, 'g')
    f.rect(s + 1, y - 1, 1, 2, 'G')


def git_merge(f, t, n):
    k = t % n
    walk = 14
    if k < walk:
        cx = -5 + int(round(k * 1.7))
        s = cx + 13
        zipper(f, s)
        st = k % 2
        info = clawd(f, x=cx, y=BY + st, view='q2r', legs=LG(st), ra='up', eyes='focus')
        hx, hy = info['rh']
        f.line(s + 1, 15, int(hx), int(hy), 'g')
        return
    cx = -5 + int(round(walk * 1.7))
    s = cx + 13
    zipper(f, s)
    j = k - walk
    f.rect(s, 10, 3, 4, MERGE)
    if j < 4:
        f.box(s - 1, 9, 5, 6, 'U')
    if j == 0:
        info = clawd(f, x=cx, view='q2r', ra='up', eyes='big')
        f.line(s + 1, 15, int(info['rh'][0]), int(info['rh'][1]), 'g')
    elif j == 1:
        clawd(f, x=cx, view='qr', eyes='happy')
    else:
        up = j % 2 == 0
        clawd(f, x=cx, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
        P.sparkles(f, k, 4, [(s + 5, 8), (s - 3, 16), (s + 6, 17)])


add('git_merge', 'git merge：拉拉链合二为一', 'git merge: zip them up', git_merge, n=22,
    dur=[120] * 14 + [380, 100, 150, 150, 150, 150, 200, 400])


# --------------------------------------------------------------------------- git rebase: lift the commits onto the tip
def git_rebase(f, t, n):
    k = t % n
    move0, move1 = 5, 11
    p = 0 if k < move0 else min(1, (k - move0) / (move1 - move0))
    main_xs = [4, 11, 18]
    f.rect(4, 6, 14 + (int(14 * p) if k >= move1 else 0), 1, MAIN)
    for x in main_xs:
        node(f, x, 6, MAIN)
    if k < move0:  # the old fork: off the commit at 11
        f.line(12, 7, 16, 11, FEAT)
        f.rect(16, 11, 12, 1, FEAT)
    elif k < move1:
        for (x, y) in ((21, 11), (28, 11)):
            node(f, x, y, None, ghost=True)
    old = [(21, 11), (28, 11)]
    new = [(25, 6), (32, 6)]
    lift = math.sin(math.pi * p) * 3
    pts = [(int(round(lerp(a[0], b[0], p))), int(round(lerp(a[1], b[1], p) - lift))) for a, b in zip(old, new)]
    if k >= move1:
        f.rect(18, 6, 14, 1, FEAT)
    elif k >= move0:
        f.rect(pts[0][0], pts[0][1], pts[1][0] - pts[0][0], 1, FEAT)
    for i, (x, y) in enumerate(pts):
        node(f, x, y, FEAT, glow=(k == move1 or (k >= move0 and k < move1)))
    if move0 <= k < move1:
        P.sparkles(f, k, 4, [(pts[0][0] - 3, pts[0][1] + 3), (pts[1][0] + 3, pts[1][1] - 2)])
    if k <= 2:
        clawd(f, x=12, eyes='normal', lookv=-1, look=1 if k == 2 else 0)
    elif k == 3:
        clawd(f, x=12, la='mid', ra='mid', eyes='focus', lookv=-1)
    elif k < move1:
        clawd(f, x=12, la='up', ra='up', eyes='focus', lookv=-1, look=1)
    elif k <= move1 + 4:
        up = k % 2 == 0
        clawd(f, x=12, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
    else:
        clawd(f, x=12, y=BY + (k % 2), h=12 - (k % 2), eyes='closed')


add('git_rebase', 'git rebase：把提交搬到最新处', 'git rebase: move them onto the tip', git_rebase, n=20,
    dur=[220, 160, 160, 120, 220, 100, 100, 100, 100, 100, 100, 380, 150, 150, 150, 150, 200, 200, 200, 400])


# --------------------------------------------------------------------------- git stash: hide it in a drawer, then take it back
STACK = ['GGGGGG', 'GWWWWG', 'GBBBWG', 'GWWWWG', 'GBBWWG', 'GGGGGG']


def cabinet(f, open_=False):
    f.rect(26, 21, 12, 15, 'N')
    f.rect(26, 21, 12, 1, 'n')
    f.rect(27, 31, 10, 1, 'n')
    f.rect(31, 33, 2, 1, 'g')
    if open_:
        f.rect(21, 24, 10, 2, 'n')      # the open drawer, seen from above
        f.rect(21, 26, 10, 4, 'T')
        f.rect(25, 27, 2, 1, 'g')
    else:
        f.rect(27, 25, 10, 4, 'T')
        f.rect(31, 26, 2, 1, 'g')


def git_stash(f, t, n):
    k = t % n
    opened = k in (3, 4, 5, 13, 14, 15)
    cabinet(f, opened)
    cx = 3
    holding = k <= 3 or k >= 15
    if k in (4, 14):
        f.art(STACK, 22, 17)
    if k in (6, 16):
        f.art(['L.L', '...'], 24, 22)
    if holding:
        look = {0: 1, 1: -1, 2: 1}.get(k, 1)
        info = clawd(f, x=cx, ra='mid', eyes='normal' if k < 15 else 'happy', look=look)
        hx, hy = info['rh']
        f.art(STACK, int(hx) - 3, int(hy) - 6)
        return
    if k in (4, 5, 6, 13, 14):
        clawd(f, x=cx, ra='reach', eyes='focus', look=1)
        return
    # nothing to see here
    j = k - 7
    clawd(f, x=cx, y=BY + (j % 2), h=12 - (j % 2), la='front', ra='front', eyes='closed')
    for i in range(2):
        q = ((j + i * 3) % 6) / 6
        f.art(P.NOTE, cx + 15 + i * 4, int(18 - q * 10))
    if j in (2, 3):
        f.art(P.SWEAT, cx - 2, 19)


add('git_stash', 'git stash：先藏抽屉再拿回', 'git stash (and pop)', git_stash, n=20,
    dur=[260, 260, 220, 140, 110, 110, 160, 220, 220, 220, 220, 220, 220, 140, 110, 160, 220, 220, 220, 300])


# --------------------------------------------------------------------------- git reset: rewind to an older commit
def git_reset(f, t, n):
    k = t % n
    xs = [4, 12, 20, 28, 36]
    head = 36 if k <= 3 else int(round(lerp(36, 20, min(1, (k - 3) / 6))))
    keep = [x for x in xs if x <= head]
    gone = [x for x in xs if x > head]
    if len(keep) > 1:
        f.rect(keep[0], 7, keep[-1] - keep[0], 1, MAIN)
    for x in keep:
        node(f, x, 7, MAIN, glow=(x == head and k >= 10 and k <= 12))
    for x in gone:
        age = x - head
        if 4 <= k <= 9 and age < 6:
            node(f, x, 7, None, ghost=True)
        elif 4 <= k <= 10 and age < 12:
            f.art(P.PUFF_S, x - 1, 6)
    f.art(['FFF', '.F.'], head - 1, 2)
    if 4 <= k <= 9:
        for i in range(3):
            f.rect(head + 4 + i * 4, 11, 2, 1, 'L')
    # the rewind button
    pressed = 3 <= k <= 5
    f.rect(27, 29, 10, 7, 'k')
    f.art(['...W...W', '..WW..WW', '.WWW.WWW', '..WW..WW', '...W...W'], 28, 30)   # rewind
    f.rrect(27, 26 + pressed, 10, 3 - pressed, 'R')
    if not pressed:
        f.rect(29, 26, 3, 1, 'Z')
    cx = 7
    if k <= 1:
        clawd(f, x=cx, eyes='worried', lookv=-1)
    elif k == 2:
        clawd(f, x=cx, ra='mid', eyes='focus', look=1)
    elif k <= 5:
        clawd(f, x=cx, y=BY + 1, h=11, ra='reach', eyes='squint' if k == 3 else 'focus', look=1)
    elif k <= 9:
        clawd(f, x=cx, eyes='big', lookv=-1)
    elif k <= 13:
        clawd(f, x=cx, y=BY + (k % 2), h=12 - (k % 2), eyes='closed')
        if k <= 11:
            f.art(P.SWEAT, cx - 2, 19)
    else:
        clawd(f, x=cx, eyes='normal' if k % 4 else 'blink', lookv=-1)


add('git_reset', 'git reset：倒带回到旧提交', 'git reset: rewind', git_reset, n=18,
    dur=[260, 200, 200, 380, 110, 110, 110, 110, 110, 110, 380, 200, 200, 200, 200, 200, 200, 400])


# --------------------------------------------------------------------------- git cherry-pick: pick one, hang it elsewhere
def cherry(f, x, y, glow=False):
    """A commit that is a cherry: ball centred on (x, y), stem up."""
    x, y = int(x), int(y)
    f.put(x + 1, y - 3, 'e'); f.put(x, y - 2, 'e')
    f.rect(x - 1, y - 1, 3, 3, 'R')
    f.put(x - 1, y - 1, 'r')
    if glow:
        f.box(x - 2, y - 4, 5, 7, 'U')


def git_cherry_pick(f, t, n):
    k = t % n
    # the purple branch keeps its cherry: cherry-pick copies it
    f.rect(0, 5, 40, 1, FEAT)
    for x in (5, 13, 31):
        node(f, x, 5, FEAT)
    cherry(f, 23, 5, glow=(k == 5))
    placed = k >= 13
    f.rect(0, 14, 23 + (6 if placed else 0), 1, MAIN)
    for x in (6, 14, 22):
        node(f, x, 14, MAIN)
    if placed:
        cherry(f, 29, 14, glow=k <= 15)
    cx = 7
    if k <= 1:
        clawd(f, x=cx, eyes='normal', lookv=-1, view='qr' if k else 'front', tilt=1 if k else 0)
        return
    if k == 2:
        clawd(f, x=cx - 1, y=BY + 2, w=18, h=10, eyes='focus')
        return
    if k <= 7:  # up, grab a copy, down
        y = {3: BY - 6, 4: BY - 10, 5: BY - 11, 6: BY - 8, 7: BY - 3}[k]
        info = clawd(f, x=cx, y=y, ra='up', la='high', legs=(1, 1, 1, 1), eyes='big' if k < 5 else 'happy')
        if k >= 5:
            hx, hy = info['rh']
            cherry(f, hx, hy - 2)
        if k == 5:
            P.sparkles(f, 1, 4, [(19, 2), (27, 3)])
        return
    if k == 8:  # land
        info = clawd(f, x=cx - 1, y=BY + 2, w=18, h=10, ra='up', eyes='squint')
        cherry(f, info['rh'][0], info['rh'][1] - 2)
        P.dust(f, cx - 3, 36, 0.2); P.dust(f, cx + 17, 36, 0.2, flip=True)
        return
    if k <= 11:  # carry it over
        st = k % 2
        x = cx + (k - 8) * 2
        info = clawd(f, x=x, y=BY + st, ra='up', legs=LG(st), eyes='happy')
        cherry(f, info['rh'][0], info['rh'][1] - 2)
        return
    if k == 12:  # on tiptoe, hang it on the blue branch
        info = clawd(f, x=cx + 6, y=BY - 3, w=16, h=14, ra='up', eyes='focus', lookv=-1)
        cherry(f, info['rh'][0], info['rh'][1] - 2)
        return
    j = k - 13
    if j < 5:
        up = j % 2 == 1
        clawd(f, x=cx + 6, y=BY - (1 if up else 0), la='up' if up else 'high', ra='up' if up else 'high', eyes='happy')
        P.sparkles(f, k, 4, [(33, 11), (25, 18)])
    else:
        clawd(f, x=cx + 6, y=BY + (j % 2), h=12 - (j % 2), eyes='closed', lookv=-1)


add('git_cherry_pick', 'git cherry-pick：摘一颗挂到别处', 'git cherry-pick', git_cherry_pick, n=22,
    dur=[220, 200, 250, 90, 90, 380, 90, 90, 220, 120, 120, 120, 300, 380, 150, 150, 150, 150, 200, 200, 200, 400])

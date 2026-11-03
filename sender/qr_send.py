#!/usr/bin/env python3
"""
qr_send.py — pure-Python GlassWire sender for air-gapped hosts with no browser (servers, SSH consoles).
Standard library only. Python 3.8+.

Modes
  --terminal   animate the QR frames in the terminal using Unicode half-blocks (▀ ▄ █).
               Works over SSH. Use a dark-on-light or light-on-dark terminal with a clean
               monospace font, make the window large, and scan the screen with the phone.
  --html FILE  write a single self-contained HTML player (file + frames embedded) that can
               be opened in any browser, for machines that have a browser but no network.
  --pbm DIR    dump every frame as a .pbm image (open with any image viewer / slideshow).

Examples
  python3 sender/qr_send.py secrets.tar.gz --terminal --fps 4
  python3 sender/qr_send.py report.pdf --html /tmp/player.html --version 15
  echo "hello air gap" | python3 sender/qr_send.py - --terminal

Protocol: see shared/qrx-protocol.js (QRX/1). Frames produced here are byte-identical to the
browser sender's, so either receiver mode accepts them.
"""
import argparse, base64, hashlib, json, math, os, secrets, sys, time, urllib.parse

# ----------------------------------------------------------------------------- QR encoder
ECC_CW = {
    'L': [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    'M': [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    'Q': [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    'H': [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
}
NUM_BLOCKS = {
    'L': [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    'M': [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    'Q': [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    'H': [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
}
ECL_BITS = {'L': 1, 'M': 0, 'Q': 3, 'H': 2}


def _raw_modules(ver):
    r = (16 * ver + 128) * ver + 64
    if ver >= 2:
        n = ver // 7 + 2
        r -= (25 * n - 10) * n - 55
        if ver >= 7:
            r -= 36
    return r


def _data_codewords(ver, ecl):
    return _raw_modules(ver) // 8 - ECC_CW[ecl][ver] * NUM_BLOCKS[ecl][ver]


def _count_bits(ver):
    return 8 if ver <= 9 else 16


def max_bytes(ver, ecl):
    return (_data_codewords(ver, ecl) * 8 - 4 - _count_bits(ver)) // 8


def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z & 0xFF


def _rs_divisor(deg):
    res = [0] * deg
    res[-1] = 1
    root = 1
    for _ in range(deg):
        for j in range(deg):
            res[j] = _gf_mul(res[j], root)
            if j + 1 < deg:
                res[j] ^= res[j + 1]
        root = _gf_mul(root, 2)
    return res


def _rs_remainder(data, div):
    res = [0] * len(div)
    for b in data:
        f = b ^ res[0]
        res = res[1:] + [0]
        for i in range(len(res)):
            res[i] ^= _gf_mul(div[i], f)
    return res


def encode_bytes(data, ecl='L', min_version=1, max_version=40, mask=None):
    """Return (version, size, mask, modules) where modules[y][x] in {0,1}."""
    ecl = ecl.upper()
    version = next((v for v in range(min_version, max_version + 1) if max_bytes(v, ecl) >= len(data)), None)
    if version is None:
        raise ValueError('data too long: %d bytes' % len(data))
    bits = []

    def put(val, n):
        bits.extend((val >> i) & 1 for i in range(n - 1, -1, -1))

    put(4, 4)
    put(len(data), _count_bits(version))
    for b in data:
        put(b, 8)
    cap = _data_codewords(version, ecl) * 8
    put(0, min(4, cap - len(bits)))
    put(0, (8 - len(bits) % 8) % 8)
    pad = 0xEC
    while len(bits) < cap:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    dcw = [0] * (len(bits) // 8)
    for i, b in enumerate(bits):
        dcw[i >> 3] |= b << (7 - (i & 7))

    size = version * 4 + 17
    mod = [[0] * size for _ in range(size)]
    fn = [[0] * size for _ in range(size)]

    def setf(x, y, d):
        mod[y][x] = 1 if d else 0
        fn[y][x] = 1

    def finder(cx, cy):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    dist = max(abs(dx), abs(dy))
                    setf(x, y, dist != 2 and dist != 4)

    def align(cx, cy):
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                setf(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)

    def align_pos():
        if version == 1:
            return []
        n = version // 7 + 2
        step = 26 if version == 32 else math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2
        res = [6]
        pos = size - 7
        while len(res) < n:
            res.insert(1, pos)
            pos -= step
        return res

    def format_bits(m):
        d = ECL_BITS[ecl] << 3 | m
        rem = d
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        b = (d << 10 | rem) ^ 0x5412
        bit = lambda i: (b >> i) & 1
        for i in range(6):
            setf(8, i, bit(i))
        setf(8, 7, bit(6)); setf(8, 8, bit(7)); setf(7, 8, bit(8))
        for i in range(9, 15):
            setf(14 - i, 8, bit(i))
        for i in range(8):
            setf(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, bit(i))
        setf(8, size - 8, 1)

    def version_bits():
        if version < 7:
            return
        rem = version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        b = version << 12 | rem
        for i in range(18):
            bit = (b >> i) & 1
            a, c = size - 11 + i % 3, i // 3
            setf(a, c, bit); setf(c, a, bit)

    for i in range(size):
        setf(6, i, i % 2 == 0); setf(i, 6, i % 2 == 0)
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
    ap = align_pos(); n = len(ap)
    for i in range(n):
        for j in range(n):
            if (i == 0 and j == 0) or (i == 0 and j == n - 1) or (i == n - 1 and j == 0):
                continue
            align(ap[i], ap[j])
    format_bits(0)
    version_bits()

    nb, ecc_len = NUM_BLOCKS[ecl][version], ECC_CW[ecl][version]
    raw = _raw_modules(version) // 8
    n_short = nb - raw % nb
    short_len = raw // nb
    div = _rs_divisor(ecc_len)
    blocks, k = [], 0
    for i in range(nb):
        dl = short_len - ecc_len + (0 if i < n_short else 1)
        dat = dcw[k:k + dl]; k += dl
        ecc = _rs_remainder(dat, div)
        blk = dat + ([0] if i < n_short else []) + ecc
        blocks.append(blk)
    allcw = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != short_len - ecc_len or j >= n_short:
                allcw.append(blk[i])

    bi, nbits = 0, len(allcw) * 8
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = size - 1 - vert if upward else vert
                if not fn[y][x] and bi < nbits:
                    mod[y][x] = (allcw[bi >> 3] >> (7 - (bi & 7))) & 1
                    bi += 1
        right -= 2

    masks = [
        lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0, lambda x, y: (x + y) % 3 == 0,
        lambda x, y: (x // 3 + y // 2) % 2 == 0, lambda x, y: (x * y) % 2 + (x * y) % 3 == 0,
        lambda x, y: ((x * y) % 2 + (x * y) % 3) % 2 == 0, lambda x, y: ((x + y) % 2 + (x * y) % 3) % 2 == 0,
    ]

    def apply(m):
        f = masks[m]
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and f(x, y):
                    mod[y][x] ^= 1

    def penalty():
        score = 0
        pat = [1, 0, 1, 1, 1, 0, 1]

        def finders(line):
            c = 0
            for i in range(len(line) - 6):
                if line[i:i + 7] == pat:
                    if (i >= 4 and not any(line[i - 4:i])) or (i + 11 <= len(line) and not any(line[i + 7:i + 11])):
                        c += 1
            return c
        for y in range(size):
            for line in (mod[y], [mod[x][y] for x in range(size)]):
                run = 1
                for i in range(1, size):
                    if line[i] == line[i - 1]:
                        run += 1
                        if run == 5:
                            score += 3
                        elif run > 5:
                            score += 1
                    else:
                        run = 1
                score += finders(line) * 40
        for y in range(size - 1):
            for x in range(size - 1):
                c = mod[y][x]
                if c == mod[y][x + 1] == mod[y + 1][x] == mod[y + 1][x + 1]:
                    score += 3
        dark = sum(map(sum, mod))
        total = size * size
        score += (math.ceil(abs(dark * 20 - total * 10) / total) - 1) * 10
        return score

    if mask is None:
        best = None
        for m in range(8):
            apply(m); format_bits(m)
            p = penalty()
            if best is None or p < best:
                best, mask = p, m
            apply(m)
    apply(mask); format_bits(mask)
    return version, size, mask, mod


# ----------------------------------------------------------------------------- QRX protocol
def random_sid():
    alpha = 'abcdefghijkmnpqrstuvwxyz23456789'
    return ''.join(alpha[b % len(alpha)] for b in secrets.token_bytes(6))


def chunk_bytes_for_capacity(cap, total=9999):
    overhead = len('|'.join(['QRX1D', 'xxxxxx', str(total), str(total), '']))
    return max(1, (cap - overhead) // 4 * 3)


def build_frames(data, name, mime, chunk_bytes, sid=None):
    sid = sid or random_sid()
    total = max(1, math.ceil(len(data) / chunk_bytes))
    frames = ['|'.join(['QRX1D', sid, str(i), str(total), base64.b64encode(data[i * chunk_bytes:(i + 1) * chunk_bytes]).decode()])
              for i in range(total)]
    header = '|'.join(['QRX1H', sid, str(total), str(len(data)), hashlib.sha256(data).hexdigest(),
                       urllib.parse.quote(name, safe=''), mime, str(chunk_bytes)])
    return sid, total, header, frames


def sequence(total, hdr_every):
    seq = []
    for i in range(total):
        if i % hdr_every == 0:
            seq.append(-1)
        seq.append(i)
    return seq


# ----------------------------------------------------------------------------- renderers
def to_halfblocks(mod, quiet=2, invert=False):
    """Two module rows per text line. Light = space, dark = block. Terminal bg should be dark
    with light text -> we print the *light* modules as blocks so the code is light-on-dark, which
    QR decoders handle (they try both polarities); --invert flips it."""
    size = len(mod)
    total = size + 2 * quiet
    grid = [[0] * total for _ in range(total)]
    for y in range(size):
        for x in range(size):
            grid[y + quiet][x + quiet] = mod[y][x]
    if total % 2:
        grid.append([0] * total)
    lines = []
    for y in range(0, len(grid), 2):
        row = ''
        for x in range(total):
            top, bot = grid[y][x], grid[y + 1][x]
            if not invert:  # draw LIGHT modules as blocks (light-on-dark terminals)
                top, bot = 1 - top, 1 - bot
            row += {(1, 1): '█', (1, 0): '▀', (0, 1): '▄', (0, 0): ' '}[(top, bot)]
        lines.append(row)
    return lines


def to_pbm(mod, scale=8, quiet=4):
    size = len(mod)
    total = size + 2 * quiet
    out = [f'P1\n{total * scale} {total * scale}\n']
    for y in range(total):
        row = []
        for x in range(total):
            v = mod[y - quiet][x - quiet] if quiet <= x < quiet + size and quiet <= y < quiet + size else 0
            row.append(('1' if v else '0') * scale)
        line = ' '.join(''.join(row)) + '\n'
        out.extend([line] * scale)
    return ''.join(out)


HTML_PLAYER = """<!doctype html><html><head><meta charset="utf-8"><title>GlassWire player — {name}</title>
<style>body{{margin:0;background:#0b0e14;color:#8b94a7;font:13px ui-monospace,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:12px}}
canvas{{background:#fff;border-radius:8px;width:min(80vh,92vw);height:auto;image-rendering:pixelated}}b{{color:#e6e9ef}}</style></head><body>
<canvas id="c"></canvas><div>frame <b id="f">–</b> · loop <b id="l">0</b> · {name} · {size} B · {total} chunks · sha256 {sha}… · <b>space</b> pause, <b>←/→</b> step</div>
<script>
const FRAMES={frames_json}, SEQ={seq_json}, FPS={fps};
const cv=document.getElementById('c'),ctx=cv.getContext('2d');let pos=0,loop=0,paused=false;
function draw(){{const i=SEQ[pos];const m=FRAMES[i<0?0:i+1];const q=4,s=m.length,t=s+2*q,px=Math.max(2,Math.floor(900/t));cv.width=cv.height=t*px;
ctx.fillStyle='#fff';ctx.fillRect(0,0,cv.width,cv.height);ctx.fillStyle='#000';
for(let y=0;y<s;y++){{const row=m[y];for(let x=0;x<s;x++)if(row.charCodeAt(x)===49)ctx.fillRect((x+q)*px,(y+q)*px,px,px);}}
document.getElementById('f').textContent=i<0?'HDR':(i+1)+'/'+{total};}}
function tick(){{if(paused)return;draw();pos=(pos+1)%SEQ.length;if(pos===0)document.getElementById('l').textContent=++loop;}}
draw();setInterval(tick,1000/FPS);
document.addEventListener('keydown',e=>{{if(e.code==='Space'){{paused=!paused;e.preventDefault();}}if(e.key==='ArrowRight'){{paused=true;pos=(pos+1)%SEQ.length;draw();}}if(e.key==='ArrowLeft'){{paused=true;pos=(pos-1+SEQ.length)%SEQ.length;draw();}}}});
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', help="file to send, or '-' for stdin")
    ap.add_argument('--name', help='filename to announce (default: basename of file / payload.txt)')
    ap.add_argument('--mime', default='application/octet-stream')
    ap.add_argument('--ecl', default='L', choices=list('LMQH'))
    ap.add_argument('--version', type=int, default=12, help='target QR version 1..40 (density). Terminals: 8–12 is realistic.')
    ap.add_argument('--fps', type=float, default=4)
    ap.add_argument('--header-every', type=int, default=8)
    ap.add_argument('--loops', type=int, default=0, help='stop after N loops (0 = forever)')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--terminal', action='store_true')
    g.add_argument('--html', metavar='FILE')
    g.add_argument('--pbm', metavar='DIR')
    ap.add_argument('--invert', action='store_true', help='terminal: dark-on-light (for light terminals)')
    a = ap.parse_args()

    if a.file == '-':
        data = sys.stdin.buffer.read(); name = a.name or 'payload.txt'; mime = a.mime if a.mime != 'application/octet-stream' else 'text/plain'
    else:
        with open(a.file, 'rb') as f:
            data = f.read()
        name, mime = a.name or os.path.basename(a.file), a.mime
    chunk = chunk_bytes_for_capacity(max_bytes(a.version, a.ecl))
    sid, total, header, frames = build_frames(data, name, mime, chunk)
    seq = sequence(total, a.header_every)
    sha = hashlib.sha256(data).hexdigest()
    sys.stderr.write(f'QRX sid={sid} {name} {len(data)} B sha256={sha[:16]}… -> {total} chunks of {chunk} B, {len(seq)} frames/loop, '
                     f'{len(seq) / a.fps:.1f} s/loop at {a.fps} fps\n')
    texts = [header] + frames
    sys.stderr.write('encoding frames… ')
    mods = [encode_bytes(t.encode(), a.ecl)[3] for t in texts]
    sys.stderr.write(f'done (QR v{encode_bytes(texts[1 if len(texts) > 1 else 0].encode(), a.ecl)[0]}, {len(mods[0])} modules)\n')

    if a.html:
        html = HTML_PLAYER.format(name=name, size=len(data), total=total, sha=sha[:12], fps=a.fps,
                                  frames_json=json.dumps([[''.join(str(v) for v in row) for row in m] for m in mods]),
                                  seq_json=json.dumps(seq))
        with open(a.html, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f'wrote {a.html} ({os.path.getsize(a.html) // 1024} KB) — open it in any browser')
        return
    if a.pbm:
        os.makedirs(a.pbm, exist_ok=True)
        for n, i in enumerate(seq):
            with open(os.path.join(a.pbm, f'frame-{n:04d}.pbm'), 'w') as f:
                f.write(to_pbm(mods[0 if i < 0 else i + 1]))
        print(f'wrote {len(seq)} frames to {a.pbm}/ (play as a slideshow at ~{a.fps} fps)')
        return

    # terminal mode
    rendered = [to_halfblocks(m, invert=a.invert) for m in mods]
    out = sys.stdout
    out.write('\x1b[?25l')  # hide cursor
    try:
        loop = 0
        while True:
            for n, i in enumerate(seq):
                lines = rendered[0 if i < 0 else i + 1]
                label = 'HDR' if i < 0 else f'{i + 1}/{total}'
                out.write('\x1b[H\x1b[2J' + '\n'.join(lines) + f'\n GlassWire {sid}  frame {label}  loop {loop}  {len(seq)} frames/loop  ^C to stop\n')
                out.flush()
                time.sleep(1 / a.fps)
            loop += 1
            if a.loops and loop >= a.loops:
                break
    except KeyboardInterrupt:
        pass
    finally:
        out.write('\x1b[?25h\n')


if __name__ == '__main__':
    main()

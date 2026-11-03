#!/usr/bin/env python3
"""
Exercise the embedded JS QR decoder (receiver/qr-decoder.js) on synthetic camera frames.

Frames come from two independent encoders (ours and OpenCV's) and get camera-like abuse:
perspective tilt, scaling, blur, sensor noise, uneven lighting, clutter around the code.
OpenCV's own decoder runs on the same frames as a yardstick.

Usage: python3 test/decoder_check.py [--n 60] [--seed 1] [--save DIR]
"""
import argparse, json, os, random, subprocess, sys, time
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'sender'))
import qr_send  # noqa: E402  (pure-Python encoder, bit-identical to the JS one)

NODE = r"""
const QRDecode = require(process.argv[1]);
const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
for (const j of jobs) {
  const gray = new Uint8Array(fs.readFileSync(j.file));
  const t0 = Date.now();
  let r = null;
  try { r = QRDecode.decodeGray(gray, j.w, j.h); } catch (e) { r = { error: String(e.stack || e) }; }
  out.push({ ok: !!(r && r.text === j.expected), text: r && r.text, error: r && r.error, ms: Date.now() - t0,
             version: r && r.version, corrected: r && r.corrected, inverted: r && r.inverted });
}
process.stdout.write(JSON.stringify(out));
"""

def matrix_to_img(mod, scale, quiet=4):
    size = len(mod); total = size + 2 * quiet
    img = np.full((total * scale, total * scale), 255, np.uint8)
    for y in range(size):
        for x in range(size):
            if mod[y][x]:
                img[(y + quiet) * scale:(y + quiet + 1) * scale, (x + quiet) * scale:(x + quiet + 1) * scale] = 0
    return img

def camera(img, rng, W=640, H=480, hard=False):
    """Place the code in a cluttered scene with perspective, blur, noise and lighting."""
    scene = np.full((H, W), rng.randint(90, 200), np.uint8)
    # clutter: a few rectangles and lines (desk, monitor bezel, text-like stripes)
    for _ in range(rng.randint(2, 6)):
        x0, y0 = rng.randint(0, W - 1), rng.randint(0, H - 1)
        cv2.rectangle(scene, (x0, y0), (x0 + rng.randint(10, 200), y0 + rng.randint(10, 120)), rng.randint(0, 255), -1)
    for _ in range(rng.randint(0, 8)):
        y = rng.randint(0, H - 1); cv2.line(scene, (0, y), (W, y), rng.randint(0, 255), rng.randint(1, 3))
    # size of the code in the frame
    # A person framing the code fills most of the view; never below ~3.5 px/module (easy) or
    # ~2.8 (hard) — below that no phone decoder works either.
    frac = rng.uniform(0.45, 0.85) if not hard else rng.uniform(0.3, 0.9)
    modules = img.shape[0] / 6
    side = int(min(min(W, H) * 0.95, max(min(W, H) * frac, modules * (3.5 if not hard else 2.8))))
    hs = img.shape[0]
    tilt = (0.08 if not hard else 0.18) * side
    cx, cy = rng.randint(side // 2 + 5, W - side // 2 - 5), rng.randint(side // 2 + 5, H - side // 2 - 5)
    j = lambda: rng.uniform(-tilt, tilt)
    dst = np.float32([[cx - side / 2 + j(), cy - side / 2 + j()], [cx + side / 2 + j(), cy - side / 2 + j()],
                      [cx + side / 2 + j(), cy + side / 2 + j()], [cx - side / 2 + j(), cy + side / 2 + j()]])
    # small rotation
    ang = rng.uniform(-12, 12) if not hard else rng.uniform(-35, 35)
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    dst = cv2.transform(dst[None], M)[0]
    src = np.float32([[0, 0], [hs, 0], [hs, hs], [0, hs]])
    P = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(img, P, (W, H), flags=cv2.INTER_AREA, borderValue=0)
    mask = cv2.warpPerspective(np.full_like(img, 255), P, (W, H), borderValue=0)
    scene[mask > 127] = warped[mask > 127]
    # uneven lighting: gradient + vignette
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = 0.6 + 0.4 * (xx / W if rng.random() < .5 else yy / H)
    if rng.random() < .5: g = g[:, ::-1]
    light = scene.astype(np.float32) * g * rng.uniform(0.7, 1.1) + rng.uniform(0, 40)
    # blur + noise
    k = rng.choice([1, 1, 3, 3, 5]) if not hard else rng.choice([3, 5, 5, 7])
    if k > 1: light = cv2.GaussianBlur(light, (k, k), 0)
    light += np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, 4 if not hard else 9, light.shape)
    return np.clip(light, 0, 255).astype(np.uint8)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=60)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--save', help='directory to dump PNGs of the frames (debugging)')
    a = ap.parse_args()
    rng = random.Random(a.seed)
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'qrx-decoder-check'); os.makedirs(tmp, exist_ok=True)
    if a.save: os.makedirs(a.save, exist_ok=True)
    jobs, meta = [], []
    cvenc = cv2.QRCodeEncoder.create()
    for i in range(a.n):
        hard = i % 3 == 2
        ver = rng.choice([2, 4, 6, 8, 10, 12, 12, 15, 18, 20])
        ecl = rng.choice('LLMMQH')
        cap = qr_send.max_bytes(ver, ecl)
        n = rng.randint(max(1, cap // 2), cap)
        text = 'QRX1D|%s|%d|%d|' % (''.join(rng.choice('abcdefgh23456789') for _ in range(6)), i, a.n)
        text += ''.join(rng.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/') for _ in range(max(0, n - len(text))))
        src = 'ours'
        if i % 4 == 3:  # independent encoder
            lvl = {'L': cv2.QRCODE_ENCODER_CORRECT_LEVEL_L, 'M': cv2.QRCODE_ENCODER_CORRECT_LEVEL_M,
                   'Q': cv2.QRCODE_ENCODER_CORRECT_LEVEL_Q, 'H': cv2.QRCODE_ENCODER_CORRECT_LEVEL_H}[ecl]
            p = cv2.QRCodeEncoder.Params(); p.correction_level = lvl; p.version = ver
            try:
                q = cv2.QRCodeEncoder.create(p).encode(text)
                q = q[:, :]  # 1 px per module, 0 = dark
                mod = [[1 if q[y, x] == 0 else 0 for x in range(q.shape[1])] for y in range(q.shape[0])]
                mod = [row[0:] for row in mod]
                src = 'opencv'
            except cv2.error:
                _, _, _, mod = qr_send.encode_bytes(text.encode(), ecl)
        else:
            _, _, _, mod = qr_send.encode_bytes(text.encode(), ecl)
        frame = camera(matrix_to_img(mod, 6), rng, hard=hard)
        f = os.path.join(tmp, f'f{i:03d}.gray'); frame.tofile(f)
        if a.save: cv2.imwrite(os.path.join(a.save, f'f{i:03d}.png'), frame)
        jobs.append({'file': f, 'w': frame.shape[1], 'h': frame.shape[0], 'expected': text, 'dim': len(mod), 'ecl': ecl, 'src': src})
        meta.append({'ver': len(mod), 'ecl': ecl, 'hard': hard, 'src': src, 'frame': frame})
    jf = os.path.join(tmp, 'jobs.json'); json.dump(jobs, open(jf, 'w'))
    t0 = time.time()
    res = json.loads(subprocess.run(['node', '-e', NODE, os.path.join(ROOT, 'receiver', 'qr-decoder.js'), jf], capture_output=True, check=True).stdout)
    t_js = time.time() - t0
    det = cv2.QRCodeDetectorAruco()
    ok_js = ok_cv = ok_js_easy = n_easy = ok_js_hard = n_hard = 0
    ms = []
    for j, r, m in zip(jobs, res, meta):
        cvt, _, _ = det.detectAndDecode(m['frame'])
        cv_ok = cvt == j['expected']
        ok_js += r['ok']; ok_cv += cv_ok; ms.append(r['ms'])
        if m['hard']: n_hard += 1; ok_js_hard += r['ok']
        else: n_easy += 1; ok_js_easy += r['ok']
        flag = '' if r['ok'] else ('  <-- ' + (r['error'][:90] if r.get('error') else ('wrong text' if r['text'] else 'no decode')))
        print(f"{'HARD' if m['hard'] else 'easy'} {m['src']:6} size={m['ver']:>3} {m['ecl']}  js={'OK ' if r['ok'] else '-- '} cv={'OK' if cv_ok else '--'}  {r['ms']:>4} ms  corr={r.get('corrected')}{flag}")
    print(f"\nembedded JS decoder: {ok_js}/{a.n}  (easy {ok_js_easy}/{n_easy}, hard {ok_js_hard}/{n_hard})   median {sorted(ms)[len(ms)//2]} ms/frame")
    print(f"OpenCV (yardstick):  {ok_cv}/{a.n}")
    sys.exit(0 if ok_js_easy >= 0.9 * n_easy else 1)

if __name__ == '__main__':
    main()

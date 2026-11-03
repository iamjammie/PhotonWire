#!/usr/bin/env python3
"""
End-to-end self-test without a phone:

  random file ──► QRX frames ──► QR matrices (sender JS)
                                   │  rendered to images, shuffled, duplicated, some dropped
                                   ▼
                   OpenCV decodes the images  (stand-in for the phone camera)
                                   ▼
                   receiver JS reassembles + verifies ──► POST /api/upload ──► stored file hash

Usage: python3 test/selftest.py [--bytes 20000] [--no-server]
Requires: node, opencv-python, numpy (dev/test only — the sender and receiver themselves need nothing).
"""
import argparse, base64, hashlib, json, os, random, subprocess, sys, threading, time, urllib.request
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'test'))
from encoder_check import render  # noqa: E402

SEND_JS = r"""
const QR = require(process.argv[1]); const QRX = require(process.argv[2]);
const job = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const bytes = new Uint8Array(Buffer.from(job.b64, 'base64'));
const cap = QR.maxBytes(job.version, job.ecl);
const chunkBytes = QRX.chunkBytesForCapacity(cap, 9999);
const built = QRX.buildFrames(bytes, { name: job.name, mime: 'application/octet-stream', sha256: job.sha256 }, { chunkBytes });
const texts = [built.header, ...built.frames];
const codes = texts.map(t => { const c = QR.encodeText(t, job.ecl); return { version: c.version, rows: c.modules.map(r => Array.from(r)) }; });
process.stdout.write(JSON.stringify({ sid: built.sid, total: built.total, chunkBytes, codes, texts }));
"""

RECV_JS = r"""
const QRX = require(process.argv[1]);
const scanned = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const rx = QRX.createReceiver();
let events = { chunk: 0, dup: 0, header: 0, ignored: 0 };
for (const s of scanned) { const ev = rx.feed(s); events[ev.kind]++; }
if (!rx.isComplete()) { console.log(JSON.stringify({ complete: false, missing: rx.missing(), events })); process.exit(0); }
const out = rx.assemble();
QRX.sha256Hex(out).then(h => console.log(JSON.stringify({ complete: true, events, sha256: h, name: rx.state.header.name, b64: Buffer.from(out).toString('base64') })));
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bytes', type=int, default=12000)
    ap.add_argument('--version', type=int, default=12)
    ap.add_argument('--ecl', default='L')
    ap.add_argument('--no-server', action='store_true')
    a = ap.parse_args()

    rng = random.Random(7)
    data = bytes(rng.getrandbits(8) for _ in range(a.bytes))
    sha = hashlib.sha256(data).hexdigest()
    print(f'[1] payload: {len(data)} B  sha256={sha[:16]}…')

    enc = os.path.join(ROOT, 'sender', 'qr-encoder.js'); proto = os.path.join(ROOT, 'shared', 'qrx-protocol.js')
    job = json.dumps({'b64': base64.b64encode(data).decode(), 'name': 'demo file.bin', 'sha256': sha, 'version': a.version, 'ecl': a.ecl})
    sent = json.loads(subprocess.run(['node', '-e', SEND_JS, enc, proto], input=job.encode(), capture_output=True, check=True).stdout)
    print(f"[2] sender: sid={sent['sid']} chunk={sent['chunkBytes']} B -> {sent['total']} data frames + header, QR v{sent['codes'][1]['version']}")

    det = cv2.QRCodeDetectorAruco()

    # (a) clean render: every frame must decode to exactly the text we encoded
    t0 = time.time()
    clean = [det.detectAndDecode(render(c['rows'], scale=5))[0] for c in sent['codes']]
    good = sum(1 for d, t in zip(clean, sent['texts']) if d == t)
    print(f'[3] clean decode (OpenCV): {good}/{len(clean)} frames exact in {time.time() - t0:.1f}s')
    assert good == len(clean), 'encoder/decoder disagreement'

    # (b) realistic scan: the sender loops; each pass the "camera" sees frames with random blur,
    #     tilt, dropped frames and a stray non-QRX code. The receiver must complete from what it
    #     actually decoded — no cheating with ground truth.
    def camera_view(rows):
        img = render(rows, scale=5)
        k = rng.choice([1, 3, 3, 5])
        img = cv2.GaussianBlur(img, (k, k), 0)
        h, w = img.shape
        j = lambda: rng.uniform(-10, 10)
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[j(), j()], [w + j(), j()], [w + j(), h + j()], [j(), h + j()]])
        return cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=255)

    stream, loops, res = ['https://example.com/not-a-qrx-frame'], 0, None
    while loops < 6:
        loops += 1
        for c in sent['codes']:
            if rng.random() < 0.25:
                continue  # camera busy / motion blur / missed frame
            stream.append(det.detectAndDecode(camera_view(c['rows']))[0])
        res = json.loads(subprocess.run(['node', '-e', RECV_JS, proto], input=json.dumps(stream).encode(), capture_output=True, check=True).stdout)
        print(f"[4] loop {loops}: receiver events={res['events']} complete={res['complete']}" + ('' if res['complete'] else f" missing={len(res['missing'])}"))
        if res['complete']:
            break
    assert res['complete'], res
    out = base64.b64decode(res['b64'])
    assert out == data and res['sha256'] == sha, 'reassembled bytes differ!'
    print(f"[5] reassembled {len(out)} B, name={res['name']!r}, sha256 matches ✔")

    if a.no_server:
        return
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server', 'receive_server.py'), '--port', '18080', '--token', 't0k3n'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(0.8)
        req = urllib.request.Request('http://127.0.0.1:18080/api/upload', data=out, method='POST', headers={
            'Content-Type': 'application/octet-stream', 'X-Filename': 'demo%20file.bin', 'X-SHA256': sha, 'Authorization': 'Bearer t0k3n'})
        body = json.loads(urllib.request.urlopen(req).read())
        print(f"[6] upload: {body}")
        assert body['ok'] and body['sha256'] == sha
        stored = os.path.join(ROOT, 'uploads', body['stored_as'])
        assert hashlib.sha256(open(stored, 'rb').read()).hexdigest() == sha
        os.remove(stored)
        # tamper check: wrong hash must be rejected
        req = urllib.request.Request('http://127.0.0.1:18080/api/upload', data=out[:-1], method='POST', headers={
            'X-Filename': 'x.bin', 'X-SHA256': sha, 'Authorization': 'Bearer t0k3n'})
        try:
            urllib.request.urlopen(req); raise AssertionError('server accepted corrupted upload')
        except urllib.error.HTTPError as e:
            assert e.code == 422, e.code
            print('[7] server rejects a corrupted body with 422 ✔')
    finally:
        srv.terminate()
    print('\nALL GOOD — the whole chain works end to end.')

if __name__ == '__main__':
    main()

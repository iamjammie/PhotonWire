#!/usr/bin/env python3
"""
Full chain with the EMBEDDED decoder as the camera: sender frames → synthetic camera frames
(clutter, tilt, blur, noise) → receiver/qr-decoder.js → QRX reassembly → SHA-256 check.
This is what the phone does when it has no native BarcodeDetector.

Usage: python3 test/chain_embedded.py [--bytes 8000] [--version 12]
"""
import argparse, base64, hashlib, json, os, random, subprocess, sys, time
import numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'sender')); sys.path.insert(0, os.path.join(ROOT, 'test'))
import qr_send  # noqa
from decoder_check import matrix_to_img, camera  # noqa

NODE = r"""
const D = require(process.argv[1]), QRX = require(process.argv[2]); const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const rx = QRX.createReceiver(); let read = 0, frames = 0;
for (const j of jobs) { frames++; const g = new Uint8Array(fs.readFileSync(j.file)); const r = D.decodeGray(g, j.w, j.h);
  if (r) { const ev = rx.feed(r.text); if (ev.kind === 'chunk' || ev.kind === 'header' || ev.kind === 'dup') read++; }
  if (rx.isComplete() && rx.state.header) break; }
if (!rx.isComplete()) { console.log(JSON.stringify({ complete: false, frames, read, missing: rx.missing().length })); process.exit(0); }
const out = rx.assemble();
QRX.sha256Hex(out).then(h => console.log(JSON.stringify({ complete: true, frames, read, sha256: h, ok: h === rx.state.header.sha256, name: rx.state.header.name })));
"""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--bytes', type=int, default=8000); ap.add_argument('--version', type=int, default=12); ap.add_argument('--seed', type=int, default=5)
    a = ap.parse_args(); rng = random.Random(a.seed)
    data = bytes(rng.getrandbits(8) for _ in range(a.bytes)); sha = hashlib.sha256(data).hexdigest()
    chunk = qr_send.chunk_bytes_for_capacity(qr_send.max_bytes(a.version, 'L'))
    sid, total, header, frames = qr_send.build_frames(data, 'embedded-test.bin', 'application/octet-stream', chunk)
    seq = qr_send.sequence(total, 8); texts = [header] + frames
    mods = [qr_send.encode_bytes(t.encode(), 'L')[3] for t in texts]
    tmp = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'qrx-chain'); os.makedirs(tmp, exist_ok=True)
    jobs = []
    for loop in range(6):                       # the sender loops; the camera sees each frame with fresh distortion
        for n, i in enumerate(seq):
            if rng.random() < 0.15: continue    # dropped frame
            fr = camera(matrix_to_img(mods[0 if i < 0 else i + 1], 6), rng, hard=False)
            f = os.path.join(tmp, f'l{loop}f{n:04d}.gray'); fr.tofile(f)
            jobs.append({'file': f, 'w': fr.shape[1], 'h': fr.shape[0]})
    jf = os.path.join(tmp, 'jobs.json'); json.dump(jobs, open(jf, 'w'))
    print(f'payload {len(data)} B -> {total} chunks of {chunk} B, QR size {len(mods[1])}; {len(jobs)} camera frames over up to 6 loops')
    t0 = time.time()
    res = json.loads(subprocess.run(['node', '-e', NODE, os.path.join(ROOT, 'receiver', 'qr-decoder.js'), os.path.join(ROOT, 'shared', 'qrx-protocol.js'), jf], capture_output=True, check=True).stdout)
    print(f'embedded decoder: {res["read"]} frames read of {res["frames"]} seen in {time.time() - t0:.1f}s -> complete={res["complete"]}', end=' ')
    if res['complete']:
        print('sha256 match =', res['ok']); assert res['ok']
    else:
        print('missing', res['missing']); sys.exit(1)
    print('ALL GOOD')

if __name__ == '__main__':
    main()

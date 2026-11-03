#!/usr/bin/env python3
"""Cross-check the JS QR encoder against OpenCV's QR decoder across versions and EC levels.

Usage: python3 test/encoder_check.py
Requires: node, opencv-python (cv2), numpy. Only needed for development/testing.
"""
import json, os, subprocess, sys, random
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ENC = os.path.join(HERE, '..', 'sender', 'qr-encoder.js')

NODE_SNIPPET = r"""
const QR = require(process.argv[process.argv.length - 1]);
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = jobs.map(j => {
  const bytes = Buffer.from(j.payload, 'base64');
  const c = QR.encodeBytes(new Uint8Array(bytes), j.ecl, { minVersion: j.version, maxVersion: j.version });
  return { version: c.version, size: c.size, mask: c.mask, rows: c.modules.map(r => Array.from(r)) };
});
process.stdout.write(JSON.stringify(out));
"""

def render(rows, scale=6, quiet=4):
    size = len(rows)
    total = size + 2 * quiet
    img = np.full((total * scale, total * scale), 255, np.uint8)
    for y, row in enumerate(rows):
        for x, v in enumerate(row):
            if v:
                img[(y + quiet) * scale:(y + quiet + 1) * scale, (x + quiet) * scale:(x + quiet + 1) * scale] = 0
    return img

def max_bytes(version, ecl):
    js = f"const QR=require('{ENC}');console.log(QR.maxBytes({version},'{ecl}'))"
    return int(subprocess.check_output(['node', '-e', js]).decode().strip())

def main():
    rng = random.Random(42)
    versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 20, 22, 25, 27, 30, 33, 36, 40]
    jobs = []
    for v in versions:
        for ecl in 'LMQH':
            cap = max_bytes(v, ecl)
            # Printable ASCII so cv2's string decoder round-trips exactly
            n = max(1, cap - rng.randint(0, 3))
            payload = ''.join(rng.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=|:-') for _ in range(n))
            jobs.append({'version': v, 'ecl': ecl, 'payload': __import__('base64').b64encode(payload.encode()).decode(), 'text': payload})
    out = subprocess.run(['node', '-e', NODE_SNIPPET, ENC], input=json.dumps(jobs).encode(), capture_output=True, check=True).stdout
    results = json.loads(out)
    det = cv2.QRCodeDetectorAruco()  # far more robust than cv2.QRCodeDetector on dense codes
    fails = 0
    for job, res in zip(jobs, results):
        assert res['version'] == job['version'], (res['version'], job['version'])
        img = render(res['rows'], scale=4 if res['size'] > 120 else 6)
        text, pts, _ = det.detectAndDecode(img)
        ok = text == job['text']
        if not ok:
            fails += 1
        print(f"v{job['version']:>2} {job['ecl']} size={res['size']:>3} mask={res['mask']} bytes={len(job['text']):>4} -> {'OK' if ok else 'FAIL (decoded %d chars)' % len(text)}")
    print(f"\n{len(jobs) - fails}/{len(jobs)} passed")
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Check that the pure-Python encoder (sender/qr_send.py) produces bit-identical matrices to the
JS encoder (sender/qr-encoder.js), and that the Python terminal/PBM output decodes with OpenCV.

Usage: python3 test/python_vs_js.py
"""
import json, os, random, subprocess, sys
import numpy as np, cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'sender'))
sys.path.insert(0, os.path.join(ROOT, 'test'))
import qr_send  # noqa: E402
from encoder_check import render  # noqa: E402

JS = r"""
const QR = require(process.argv[1]);
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(jobs.map(j => {
  const c = QR.encodeBytes(new Uint8Array(Buffer.from(j.text, 'utf8')), j.ecl);
  return { version: c.version, mask: c.mask, rows: c.modules.map(r => Array.from(r)) };
})));
"""

def main():
    rng = random.Random(3)
    jobs = []
    for ecl in 'LMQH':
        for n in (5, 17, 40, 100, 250, 400, 700, 1200):
            jobs.append({'ecl': ecl, 'text': ''.join(rng.choice('abcXYZ019|/+=') for _ in range(n))})
    js = json.loads(subprocess.run(['node', '-e', JS, os.path.join(ROOT, 'sender', 'qr-encoder.js')],
                                   input=json.dumps(jobs).encode(), capture_output=True, check=True).stdout)
    bad = 0
    for j, r in zip(jobs, js):
        v, size, mask, mod = qr_send.encode_bytes(j['text'].encode(), j['ecl'])
        same = (v == r['version'] and mask == r['mask'] and mod == r['rows'])
        bad += not same
        print(f"{j['ecl']} {len(j['text']):>5} B  py v{v} m{mask}  js v{r['version']} m{r['mask']}  {'identical' if same else 'DIFFERENT'}")
    assert not bad, f'{bad} mismatches'

    # terminal half-block rendering -> decode (simulate a monospace terminal screenshot)
    det = cv2.QRCodeDetectorAruco()
    _, _, _, mod = qr_send.encode_bytes(b'QRX1D|abcdef|0|1|aGVsbG8gYWlyIGdhcA==', 'M')
    lines = qr_send.to_halfblocks(mod, quiet=2)
    cell_w, cell_h = 6, 12
    img = np.zeros((len(lines) * cell_h, len(lines[0]) * cell_w), np.uint8)  # dark terminal bg
    for y, line in enumerate(lines):
        for x, ch in enumerate(line):
            top = ch in '█▀'; bot = ch in '█▄'
            if top: img[y * cell_h:y * cell_h + cell_h // 2, x * cell_w:(x + 1) * cell_w] = 255
            if bot: img[y * cell_h + cell_h // 2:(y + 1) * cell_h, x * cell_w:(x + 1) * cell_w] = 255
    img = cv2.copyMakeBorder(img, 30, 30, 30, 30, cv2.BORDER_CONSTANT, value=0)
    text, _, _ = det.detectAndDecode(img)
    if not text:  # some decoders want dark-on-light; the phone's decoder tries both
        text, _, _ = det.detectAndDecode(255 - img)
    print('terminal half-block render decodes:', text == 'QRX1D|abcdef|0|1|aGVsbG8gYWlyIGdhcA==')
    assert text == 'QRX1D|abcdef|0|1|aGVsbG8gYWlyIGdhcA=='
    print('\nPython encoder == JS encoder, terminal rendering decodes. ✔')

if __name__ == '__main__':
    main()

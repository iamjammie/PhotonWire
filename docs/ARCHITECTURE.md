# GlassWire — Architecture

How GlassWire is built, how data flows through it, and how to extend it. Aimed at contributors.

---

## Design principles

1. **Two self-contained files, zero dependencies, zero network.** `dist/sender.html` and
   `dist/receiver.html` each carry their own QR codec and the shared protocol code. This is a hard
   constraint — it is what makes the tool usable on an isolated machine on one side and a phone
   with nothing installed on the other.
2. **Codecs separate from UI.** The encoder, the decoder and the protocol are framework-free
   modules with no DOM access, loadable in Node for tests. The two `index.html` files are thin
   presentation layers.
3. **Two reference senders, one format.** The browser sender (JS) and the terminal sender
   (Python) produce bit-identical QR matrices from identical frames; a test enforces it.
4. **Verified end to end.** Integrity is the SHA-256 in the header; the receiver, and the optional
   upload server, both re-check it.

## Repository layout

```
sender/
  index.html          Browser sender UI: file/text input, settings, playback, stats.
  qr-encoder.js       QR encoder: byte mode, versions 1–40, EC L/M/Q/H, mask selection, canvas/SVG.
  qr_send.py          Pure-Python sender: same encoder ported, plus terminal / HTML / PBM renderers.
receiver/
  index.html          Phone receiver UI: live camera, video clip, photos; progress; share/save/upload.
  qr-decoder.js       QR decoder (see below).
  manifest.webmanifest, sw.js, icon-*.png   Installable-app shell (optional; hosted use only).
shared/
  qrx-protocol.js     QRX/1: base64, framing, chunk sizing, parse, stateful reassembler, SHA-256.
server/
  receive_server.py   Optional stdlib HTTP(S) server: serves the receiver, accepts verified uploads.
test/                 See "Testing".
build.py              Inlines the modules into dist/.
dist/                 Build output (committed): sender.html, receiver.html, app/ (PWA folder).
```

## Data flow

```
 file ──► buildFrames() ──► [header, d0, d1, …] ──► QR.encodeText() per frame ──► canvas, looped
                                                                                      │ light
 share sheet ◄── sha256 check ◄── assemble() ◄── receiver.feed(text) ◄── decode frame ◄┘
```

Sender: `QRX.buildFrames(bytes, meta, {chunkBytes})` returns the header string and the data
strings; `QRX.chunkBytesForCapacity(QR.maxBytes(version, ecl))` picks the chunk size so that a
data frame fills the chosen QR version. Each frame is encoded once and cached as a canvas; the
play loop just blits.

Receiver: every decoded string goes through `QRX.createReceiver().feed(text)`, which returns an
event (`ignored`, `header`, `chunk`, `dup`) and tracks completeness. The UI reacts to events; it
never parses frames itself. On completion `assemble()` yields the bytes and `sha256Hex()` verifies
them against the header.

## The encoder (`sender/qr-encoder.js`, `qr_send.py`)

A straightforward ISO 18004 byte-mode encoder: capacity tables, bit stream with terminator and
pad bytes, Reed–Solomon over GF(2⁸) (polynomial 0x11D) per block with interleaving, function
patterns (finders, timing, alignment, format and version information), zigzag placement, all
eight masks scored with the four penalty rules. The Python port mirrors the JS line for line so
that `test/python_vs_js.py` can assert identical matrices.

## The decoder (`receiver/qr-decoder.js`)

The decoder is what lets the receiver stay dependency-free on phones without a native barcode
API. It follows the ZXing pipeline:

1. **Binarise** — hybrid local threshold: 8×8 block minima/averages, 5×5 block smoothing, per-pixel
   compare. Handles uneven lighting across a screen.
2. **Find finder patterns** — scan every row for the 1:1:3:1:1 run ratio (with a tolerance that
   grows with module size), cross-check vertically, horizontally (±1 row) and diagonally, and
   merge repeat hits into candidates with a confidence count.
3. **Choose a triple** — from the best candidates pick triples that form a right isosceles
   triangle with similar module sizes; order as top-left / top-right / bottom-left by the sign of
   the cross product.
4. **Estimate the dimension** — the finder-derived estimate is unreliable under blur and
   perspective, so each plausible dimension (21…177, step 4) is scored by how well the timing
   patterns alternate under a provisional homography; confident matches are tried first, then
   the estimate's neighbours.
5. **Locate alignment patterns** — a rotation-aware 5×5 template search around the predicted
   position (coarse, then fine with centroid refinement). For versions ≥ 7 every alignment pattern
   is located and the homography is re-fitted by least squares over all of them, which absorbs
   lens distortion and screen curvature.
6. **Sample the grid** through the homography, read and Hamming-correct the format and version
   information, unmask, read the codewords in zigzag order, de-interleave the blocks.
7. **Reed–Solomon decode** each block (Euclidean algorithm, Forney for magnitudes), concatenate the
   data codewords, parse the byte / numeric / alphanumeric segments (ECI and FNC1 are skipped,
   Kanji unsupported), and return UTF-8 text.

If nothing decodes, the binarised image is inverted and the pipeline runs again, which is how
light-on-dark terminal renderings are read.

Typical cost on a 640×480 frame is 5–15 ms in Node; on a phone the receiver downsamples the
camera frame to ≤ 800 px first.

## The receiver UI's input paths

| Path | Source element handed to `decodeFn` | Notes |
|---|---|---|
| Live camera | the `<video>` of a `getUserMedia` stream | needs a secure context; wake lock, torch and zoom where available |
| Video clip | an offscreen `<video>` playing a picked file, frame-stepped with `requestVideoFrameCallback` | no permissions, no network; progress kept across clips |
| Photos | `createImageBitmap(file)` | one decode per image |

`decodeFn` tries the native `BarcodeDetector` when the browser has one and silently switches to
`QRDecode.decodeImageData` on failure.

## Build

`python3 build.py` is a trivial inline step: it replaces each `<script src="…">` that points at a
local file with the file's contents (escaping `</script`), and writes:

- `dist/sender.html` — the portable sender.
- `dist/receiver.html` — the portable receiver.
- `dist/app/` — the receiver plus manifest, service worker and icons for hosting as an installable
  app. The service worker caches the shell so an installed app works offline.

Nothing else is transformed; what you read in `sender/`, `receiver/` and `shared/` is what ships.

## Testing

| Script | What it proves | Needs |
|---|---|---|
| `encoder_check.py` | Every QR version × EC level produced by the JS encoder at full capacity decodes with OpenCV to the original text | node, cv2 |
| `python_vs_js.py` | The Python encoder emits the same version, mask and modules as JS; a half-block terminal rendering decodes | node, cv2 |
| `decoder_check.py` | The embedded decoder's hit rate on synthetic camera frames (clutter, rotation, perspective, blur, noise, lighting), with OpenCV as a yardstick; fails under 90 % on easy frames | node, cv2 |
| `chain_embedded.py` | Sender frames → camera simulation over several loops → embedded decoder → reassembly → hash | node, cv2 |
| `selftest.py` | Same chain with OpenCV as the camera, plus the upload server accepting a good body and rejecting a corrupted one | node, cv2 |

The camera simulation is shared (`decoder_check.camera`) so the two chain tests exercise the same
distortions.

## Extending

- **Higher throughput:** change the frame payload encoding (see PROTOCOL.md → extensions) in
  `shared/qrx-protocol.js`; both encoders and the receiver pick it up through `buildFrames` /
  `parseFrame`.
- **Another sender surface** (e-ink, LED matrix, a different terminal glyph set): a renderer in
  `qr_send.py` that takes the module matrix from `encode_bytes`.
- **Another receiver input:** feed decoded strings to `handle(text)` in `receiver/index.html`.
- **Decoder robustness:** `test/decoder_check.py --save DIR` dumps the frames it generated as PNGs
  so a failing case can be examined; add a case, then fix.

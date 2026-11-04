# Contributing to Photonwire

Thanks for your interest in improving QRX. It is a two-file, fully offline optical file
transfer, and a few constraints keep it that way — please read these before opening a PR.

## Golden rules

1. **Zero network, zero dependencies.** `dist/sender.html` and `dist/receiver.html` must make no
   network requests and load no external scripts, stylesheets, fonts or data. Everything is
   inlined; the QR encoder and decoder are our own. A PR that adds a CDN script or a runtime
   fetch to either page will not be merged. (The optional `server/` and the live-camera path are
   the only places the network is touched, and both are opt-in.)
2. **One-way stays one-way.** Nothing may flow from the receiver back to the sender. Features that
   would need a return channel (ARQ, acknowledgements) belong in a different tool.
3. **Keep the codecs DOM-free.** `sender/qr-encoder.js`, `receiver/qr-decoder.js` and
   `shared/qrx-protocol.js` take plain arrays and return plain data, so they run in Node for tests.
   UI code lives in the two `index.html` files.
4. **Decoders must be defensive.** Camera frames are noise; a malformed or truncated frame must
   return `null`, never throw. Frames from the screen are untrusted input on the phone side.
5. **Verify, don't trust.** Any change to framing or reassembly must keep the end-to-end SHA-256
   check intact and must keep `qr_send.py` bit-identical to the JS sender.

## Project layout

```
sender/     index.html · qr-encoder.js · qr_send.py
receiver/   index.html · qr-decoder.js · manifest.webmanifest · sw.js · icons
shared/     qrx-protocol.js        QRX/1 framing, chunking, reassembly, SHA-256
server/     receive_server.py      optional stdlib HTTPS host + upload endpoint
test/       encoder / decoder / end-to-end checks (need node, opencv-python, numpy)
docs/       USER_GUIDE · PROTOCOL · ARCHITECTURE · CHANGELOG
build.py    inlines sources into dist/sender.html, dist/receiver.html, dist/app/
```

## Build & test

```bash
python3 build.py                   # regenerate dist/ (commit the result)
python3 test/encoder_check.py      # JS encoder vs OpenCV, all versions × EC levels
python3 test/python_vs_js.py       # Python encoder == JS encoder; terminal render decodes
python3 test/decoder_check.py      # embedded decoder on synthetic camera frames (reports a %)
python3 test/chain_embedded.py     # sender -> camera sim -> embedded decoder -> reassembly
python3 test/selftest.py           # full chain incl. the optional upload server
```

All must pass. `decoder_check.py` exits non-zero if the easy-frame decode rate drops below 90 %;
please report the before/after rate in any PR that touches the decoder. CI runs the same checks and
also verifies that `dist/` matches the sources.

For the no-network guarantee, open the built files with the browser forced offline (DevTools →
Network → Offline) and check that nothing fails.

## Adding things

- **A sender renderer** (e.g. e-ink, a different terminal glyph set): add a function next to
  `to_halfblocks` in `qr_send.py` and a `--mode` flag. Frames themselves come from `build_frames`
  and must not change.
- **A receiver input** (e.g. a screen-recording import): decode each frame to text and call
  `handle(text)` in `receiver/index.html`; everything downstream is shared.
- **A protocol change:** bump the magic (`QRX1` → `QRX2`) rather than changing field meaning in
  place, update `docs/PROTOCOL.md`, and keep `parseFrame` accepting the old version for one
  release.
- **Decoder robustness:** add a failing case to `test/decoder_check.py` first (it has a `--save`
  flag that dumps the frames as PNGs for inspection), then fix.

## Style

Match the surrounding code: no framework, no build tooling beyond `build.py`, small focused
helpers, and comments that explain *why* (a tolerance, a threshold, a fallback), not just what.

## Licensing

By contributing you agree your work is released under the project's MIT License.

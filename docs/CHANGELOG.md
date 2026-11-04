# Photonwire — Changelog

All notable changes to QRX. The project is a two-file, fully offline optical file transfer;
versions track the sender, receiver and QRX protocol together.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## 1.0.0 — First release

### Added
- **QRX/1 protocol** — text frames with a header (filename, size, SHA-256, chunking) repeated every
  *N* frames and self-locating data frames; random session ids; order-independent reassembly.
  Documented in `docs/PROTOCOL.md`.
- **Browser sender** (`sender.html`) — file or pasted text in, looping QR codes out; adjustable QR
  version (8–40), EC level, frame rate and header interval; live stats (chunk size, frames per
  loop, loop time, goodput); keyboard control and fullscreen stage.
- **Terminal sender** (`qr_send.py`) — pure Python standard library; Unicode half-block rendering
  for terminals and SSH, a standalone HTML player, and PBM frame export. Bit-identical frames to
  the browser sender.
- **Dependency-free QR encoder** (byte mode, versions 1–40, EC L/M/Q/H) in JS and Python,
  verified against OpenCV on all 88 version × EC combinations at full capacity.
- **Phone receiver** (`receiver.html`) — live camera scanning, decoding of a recorded video clip,
  and photos; chunk grid, missing-index list and decode-rate readout; SHA-256 verification;
  **Share…** to the phone's native share sheet, **Save to phone**, **Copy as text**; optional
  forwarding to an HTTP endpoint.
- **Dependency-free QR decoder** embedded in the receiver — hybrid binarisation, finder and
  alignment detection, timing-pattern dimension scoring, least-squares homography refinement,
  Reed–Solomon correction, inverted-image retry. Uses the native `BarcodeDetector` when present.
- **Installable app shell** — manifest, service worker and icons so the hosted receiver can be
  added to a home screen and run offline.
- **Optional receive server** (`server/receive_server.py`) — standard library only; serves the
  receiver over HTTP or self-signed HTTPS, accepts raw-body uploads with hash re-verification and
  an optional bearer token.
- **Tests** — encoder correctness, Python/JS parity, decoder robustness on synthetic camera frames,
  and two end-to-end chain simulations; GitHub Actions workflow runs them and checks that `dist/`
  is current and self-contained.

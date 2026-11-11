<div align="center">

# Photonwire

**Offline file transfer across an air gap — by screen and camera.**

The isolated machine shows the file as a loop of QR codes; a phone reads it back, verifies the SHA-256, and hands it to the phone's share sheet. Two self-contained HTML files, nothing else.

`Version 1.0.0` · Runtime: any browser (sender) · any phone browser (receiver) · Dependencies: **none** · Network calls: **zero**

[Quick start](#quick-start) · [What it does](#what-it-does) · [Documentation](docs/) · [QRX/1 protocol](docs/PROTOCOL.md) · [Download the two files](dist/)

</div>

---

<!-- suite-nav:start -->
> **Part of the [iamjammie Hunt suite](https://iamjammie.github.io/FluxHunt/suite.html)** — open-source, offline-first security tooling and knowledge.
>
> 🧠 [Hunt-Sage](https://github.com/iamjammie/hunt-sage) (knowledge) · 🌊 [FluxHunt](https://github.com/iamjammie/FluxHunt) (wire) · 🖥️ [HostHunt](https://github.com/iamjammie/HostHunt) (box) · 📡 [HostVigil](https://github.com/iamjammie/HostVigil) (fleet) · 🔐 [ADHuntX](https://github.com/iamjammie/ADHuntX) (directory) · 🎯 [Sentinel Matrix](https://github.com/iamjammie/Sentinel-Matrix) (detection coverage) · 🧬 [TTP NEXUS](https://github.com/iamjammie/TTP-Nexus) (frameworks) · 🛡️ [ThreatIntFlux](https://github.com/iamjammie/ThreatIntFlux) (threat intel) · 🔦 **Photonwire** (air gap) · 🛰️ [SPECTRA](https://github.com/iamjammie/SPECTRA---Space-Cyber-Framework) (space)
>
> [Suite hub](https://iamjammie.github.io/FluxHunt/suite.html) · [All projects](https://github.com/iamjammie)
<!-- suite-nav:end -->

Air-gapped and isolated systems are built so that nothing gets in. The price is that nothing
easily gets *out* either — a log export, a config dump, a scan result, a triage report — when
there is no network, no approved USB route and no cable. Photonwire is a one-way optical channel for
exactly that: the file is chunked, each chunk becomes a QR code, the codes animate in a loop on
the isolated screen, and a phone pointed at the screen reassembles the file, checks its hash, and
saves or shares it.

Both ends are **single, self-contained HTML files**. `sender.html` carries its own QR encoder and
`receiver.html` carries its own QR decoder, so neither page loads anything from anywhere. Nothing
crosses the gap but light, and nothing flows back into the isolated machine.

> Photonwire is a **defensive, one-way data channel** for operators who must move small files out of
> environments they are authorised to work in. It cannot inject anything into an isolated system,
> and it makes no attempt to hide: the transfer is visible on a screen the whole time.

## What it does

- **Sends any file over a screen.** Drop a file (or paste text) into `sender.html`; it is chunked
  into the QRX/1 frame format, each frame encoded as one QR code, and the codes animate in a loop.
  Density (QR version 8–40), error-correction level, frame rate and header interval are adjustable
  to match the screen and camera at hand.
- **Works on headless hosts too.** `qr_send.py` is pure Python standard library and animates the
  same frames as Unicode half-blocks in a terminal — over SSH if need be — or writes a standalone
  HTML player or PBM images.
- **Receives on the phone, offline.** `receiver.html` scans with the live camera, or decodes a
  video clip of the screen recorded with the phone's normal camera app, or a set of photos.
  Frames can arrive in any order; missed ones come round on the next loop. A chunk grid shows
  progress and exactly which chunks are still missing.
- **Verifies, then shares.** The header frame carries the filename, size and SHA-256. On
  completion the hash is checked and **Share…** opens the phone's native share sheet;
  **Save to phone** writes to Downloads / Files; optional forwarding to an HTTP endpoint is
  included for lab setups.
- **Carries its own codecs.** A from-scratch QR encoder (byte mode, versions 1–40, EC L/M/Q/H)
  and a from-scratch QR decoder (adaptive binarisation, finder and alignment detection,
  perspective correction, Reed–Solomon error correction). The phone's native `BarcodeDetector`
  is used when present for speed; the embedded decoder is the fallback and the guarantee.
- **Installs as an app.** Served once over HTTPS, the receiver can be added to the home screen
  and then runs full-screen with no connectivity (service worker + manifest included).

## Quick start

**1. Isolated side.** Copy `dist/sender.html` to the machine (it is one file) and open it in any
browser. Drop in the file and press **Start**. Or, on a headless box:

```bash
python3 sender/qr_send.py export.tar.gz --terminal --fps 4 --version 10
```

**2. Phone.** Open `dist/receiver.html` on the phone — from a local copy, or from anywhere it is
hosted over HTTPS — and either tap **Start camera**, or film one full loop of the screen with the
camera app and tap **Record / pick a video**.

**3. Hold steady.** Fill the reticle with the code, 20–40 cm away. The chunk grid fills in; when
every chunk has arrived the hash is verified and the camera stops.

**4. Share.** Tap **Share…** and pick the app, or **Save to phone**.

Try it without a phone: `python3 test/selftest.py` simulates the entire chain, camera included.

See the [**User Guide**](docs/USER_GUIDE.md) for tuning, platform notes and troubleshooting.

## Documentation

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview and entry point. |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | Step-by-step guide to both ends, every setting, hosting options and troubleshooting. |
| [PROTOCOL.md](docs/PROTOCOL.md) | The QRX/1 frame format (the wire format Photonwire carries), so other senders and receivers can interoperate. |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the encoder, decoder and apps are built, the build step, and how to extend them. |
| [CHANGELOG.md](docs/CHANGELOG.md) | Version history. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Golden rules, layout, tests. |

## Throughput

Goodput ≈ chunk bytes × frames per second. Typical figures on a laptop screen and a recent phone:

| QR version | Modules | Bytes / frame (EC L) | at 6 fps | 100 KB takes |
|---|---|---|---|---|
| 10 | 57 | 186 | 1.1 KB/s | ~90 s |
| 12 (default) | 65 | 258 | 1.5 KB/s | ~65 s |
| 15 | 77 | 390 | 2.3 KB/s | ~45 s |
| 20 | 97 | 639 | 3.7 KB/s | ~27 s |

Per loop; frames the camera misses are picked up on the next pass. Compress first (`gzip`,
`zip`) — text, JSON and HTML shrink 5–10×. Tuning guidance is in the
[User Guide](docs/USER_GUIDE.md#7-tuning-throughput).

## Honest limitations

- **Bandwidth is low.** This is a kilobytes-per-second channel for reports, exports and small
  archives, not for disk images. Compress, and split large transfers into several files.
- **One-way and optical.** The phone cannot ask for a retransmission; it waits for the loop. That
  is also the security property: nothing reaches the isolated host.
- **Anyone who can see the screen can read the data.** The channel is not confidential. Encrypt
  before sending if the content is sensitive (`gpg -c file` on the isolated side; Photonwire forwards
  opaque bytes unchanged).
- **Integrity, not authenticity.** The SHA-256 proves the phone got exactly what the screen
  showed. Sign the file, or use a MAC with a pre-shared key, if you must prove who sent it.
- **Platform rules for local files differ.** Android Chrome runs `receiver.html` from a local file
  with the live camera; stock iOS will not run scripts from a local HTML file at all, so on iPhone
  the receiver is opened once from any HTTPS location and added to the home screen (it then runs
  offline). Details in the [User Guide](docs/USER_GUIDE.md#6-platform-notes).
- **Camera quality bounds density.** Glare, moiré and autofocus hunting are real. If decode rates
  are low, drop to QR version 10 and 4 fps and work upward.

## Responsible use

An optical channel bypasses network controls by design. Photonwire is for operators, responders and
administrators who are **authorised** to move data out of an isolated environment and whose
data-handling policy permits it. Do not use it to circumvent controls you do not own. The
transfer is deliberately conspicuous — a screen full of flashing codes — and leaves the isolated
system untouched.

## Testing

```bash
python3 test/encoder_check.py      # JS encoder vs OpenCV decoder, v1–40 × L/M/Q/H (88 cases)
python3 test/python_vs_js.py       # Python encoder bit-identical to JS; terminal render decodes
python3 test/decoder_check.py      # embedded decoder vs OpenCV on cluttered, tilted, blurred frames
python3 test/chain_embedded.py     # full chain using the embedded decoder as the camera
python3 test/selftest.py           # full chain incl. simulated camera and the optional upload server
```

The tests need `node`, `opencv-python` and `numpy`. The sender, receiver and server need nothing.

## Building from source

The repository ships the readable sources and a tiny build step that inlines them into the
single-file apps:

```
sender/index.html + sender/qr-encoder.js + shared/qrx-protocol.js      -> dist/sender.html
receiver/index.html + receiver/qr-decoder.js + shared/qrx-protocol.js  -> dist/receiver.html
                                                                        -> dist/app/  (installable PWA)
python3 build.py
```

## Layout

```
sender/     index.html · qr-encoder.js      browser sender and its QR encoder
            qr_send.py                      pure-Python sender (terminal / HTML player / PBM)
receiver/   index.html · qr-decoder.js      phone receiver and its QR decoder
            manifest.webmanifest · sw.js    installable-app shell
shared/     qrx-protocol.js                 QRX/1 framing, chunking, reassembly, SHA-256
server/     receive_server.py               optional HTTPS host + upload endpoint (stdlib)
test/       encoder, decoder and end-to-end chain tests
docs/       user guide, protocol, architecture, changelog
```

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE).

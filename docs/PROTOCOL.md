# QRX/1 — the Photonwire frame protocol

QRX/1 is the format Photonwire puts inside each QR code. It is deliberately simple and text-based so
that a frame can be read by any QR scanner, inspected by eye, and re-implemented in a few dozen
lines. This document is the normative description; `shared/qrx-protocol.js` and
`sender/qr_send.py` are the reference implementations and must agree byte for byte.

---

## Design goals

- **Receiver joins at any time, in any order.** The sender loops forever. There is no handshake,
  no acknowledgement and no return path.
- **Self-describing.** Every data frame carries enough to place itself; the header frame carries
  everything needed to name and verify the file.
- **Scanner-friendly.** Frames are printable UTF-8 text: QR *byte mode*, no binary, so every
  decoder — native, library or embedded — returns the same string.
- **Stale-proof.** A random session id lets a receiver ignore frames from an earlier transfer that
  may still be visible on another screen.

## Frames

Fields are separated by `|`. The payload is always the last field and is standard base64
(`A–Z a–z 0–9 + /` with `=` padding), which never contains `|`.

### Header frame

```
QRX1H|<sid>|<total>|<size>|<sha256>|<name>|<mime>|<chunkBytes>
```

| Field | Meaning |
|---|---|
| `QRX1H` | magic: protocol **QRX**, version **1**, frame type **H**eader |
| `sid` | 6-character session id, alphabet `abcdefghijkmnpqrstuvwxyz23456789` (no `l`, `o`, `0`, `1`) |
| `total` | number of data chunks, decimal, ≥ 1 |
| `size` | file length in bytes, decimal |
| `sha256` | lowercase hex SHA-256 of the whole file; may be empty if the sender cannot hash |
| `name` | filename, percent-encoded (`encodeURIComponent` / `urllib.parse.quote(name, safe='')`) |
| `mime` | MIME type, or `application/octet-stream` |
| `chunkBytes` | raw bytes per chunk before base64 (informational) |

Example:

```
QRX1H|k7m2qp|47|12000|170535ef52c402724ee6f23fbc8573ffa6cf660e4b6003e177ee1aed4c39eeb0|demo%20file.bin|application/octet-stream|258
```

### Data frame

```
QRX1D|<sid>|<idx>|<total>|<base64 chunk>
```

| Field | Meaning |
|---|---|
| `QRX1D` | magic: frame type **D**ata |
| `sid` | same session id as the header |
| `idx` | 0-based chunk index |
| `total` | number of chunks (repeated here so progress works before a header is seen) |
| payload | base64 of bytes `[idx·chunkBytes, (idx+1)·chunkBytes)` of the file; the last chunk may be shorter |

Example:

```
QRX1D|k7m2qp|3|47|U29tZSBjaHVuayBvZiB0aGUgZmlsZS4uLg==
```

## Sender behaviour

1. Choose `chunkBytes` from the QR capacity: with `cap` = byte-mode capacity of the chosen version
   and EC level, overhead = length of `QRX1D|xxxxxx|<total>|<total>|`, then
   `chunkBytes = floor((cap − overhead) / 4) × 3` so the base64 payload fits exactly.
2. `total = max(1, ceil(size / chunkBytes))`.
3. Play order: the header, then data frames `0 … total−1`, with the header re-inserted every *N*
   data frames (default 8). Loop indefinitely.
4. Encode each frame as a QR code in byte mode at the chosen EC level, letting the version float
   up to fit (frames near capacity will land on the chosen version; the header is usually
   smaller).

A frame is never changed after a session starts. To send a different file, start a new session
with a new `sid`.

## Receiver behaviour

1. Ignore any scanned string that does not start with `QRX1H|` or `QRX1D|`, or whose field count
   or numeric fields are malformed.
2. On the first valid frame, adopt its `sid`. On a valid frame with a *different* `sid`, discard
   the current state and adopt the new one (a new transfer has started).
3. Store data chunks by `idx`; duplicates are harmless. `total` comes from the first data frame
   or the header, whichever arrives first.
4. The transfer is **complete** when every index in `0 … total−1` is present. Concatenate in index
   order.
5. If a header has been seen, compare SHA-256 of the assembled bytes with the header's. Mismatch
   means corruption: discard and keep scanning (in practice the QR codes' own Reed–Solomon layer
   makes a wrongly-decoded chunk vanishingly rare; a damaged code fails to decode rather than
   decoding wrongly).
6. Without a header the receiver can still assemble, but cannot name or verify the file; it keeps
   listening for one.

## Capacity reference (bytes per frame, EC level L)

| QR version | Modules | Byte-mode capacity | `chunkBytes` (total < 10 000) |
|---|---|---|---|
| 8 | 49 | 192 | 144 |
| 10 | 57 | 271 | 186 |
| 12 | 65 | 367 | 258 |
| 15 | 77 | 520 | 390 |
| 18 | 89 | 718 | 519 |
| 20 | 97 | 858 | 639 |
| 25 | 117 | 1 273 | 948 |
| 30 | 137 | 1 732 | 1 293 |
| 40 | 177 | 2 953 | 2 208 |

## Versioning

The magic carries the protocol version. A future `QRX2…` may change fields freely; a QRX/1
receiver must ignore it (rule 1 above) and a QRX/2 receiver should keep accepting QRX/1 for at
least one release. Within QRX/1, no field may change meaning.

## Known extensions (not in QRX/1)

Natural next steps that would each be a QRX/2 feature:

- **Alphanumeric mode with base45** instead of byte mode with base64 — about 20 % more payload per
  frame.
- **Fountain codes** (e.g. Luby Transform) instead of fixed chunks — removes the "wait a whole loop
  for one missing chunk" tail on long transfers, at the cost of a slightly larger decoder.
- **Compression flag** in the header, so the receiver can inflate automatically.

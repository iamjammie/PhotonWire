/*
 * qrx-protocol.js — the QRX/1 frame format shared by the sender and the receiver.
 *
 * Every QR code carries one UTF-8 text frame. Fields are '|' separated; the payload is
 * standard base64 (always the last field, so it may never contain '|').
 *
 *   Header frame (repeated periodically so the receiver can join at any time):
 *     QRX1H|<sid>|<total>|<size>|<sha256-hex>|<filename-urlencoded>|<mime>|<chunkBytes>
 *
 *   Data frame:
 *     QRX1D|<sid>|<idx>|<total>|<base64 chunk>
 *
 *   sid      6-char random session id — lets the receiver ignore stale frames from a
 *            previous transfer still visible on screen.
 *   idx      0-based chunk index; total = number of chunks.
 *   size     original file length in bytes; sha256 is over the whole file.
 *
 * The receiver needs no ordering: it collects chunks by idx, and the sender loops forever,
 * so any frame the camera missed comes around again. Completion = all idx seen; integrity =
 * SHA-256 matches the header.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC_H = 'QRX1H', MAGIC_D = 'QRX1D';

  // --- base64 that works in browsers and Node without Buffer ---
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_REV = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();
  function b64encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] +
        (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') +
        (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function b64decode(str) {
    str = str.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor(str.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < str.length; i += 4) {
      const a = B64_REV[str.charCodeAt(i)], b = B64_REV[str.charCodeAt(i + 1)];
      const c = i + 2 < str.length ? B64_REV[str.charCodeAt(i + 2)] : -1;
      const d = i + 3 < str.length ? B64_REV[str.charCodeAt(i + 3)] : -1;
      if (a < 0 || b < 0) throw new Error('bad base64');
      out[o++] = (a << 2) | (b >> 4);
      if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0) out[o++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, o);
  }

  function randomSid() {
    const alpha = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint8Array(6)) : Array.from({ length: 6 }, () => Math.random() * 256 | 0);
    for (const v of rnd) s += alpha[v % alpha.length];
    return s;
  }

  // ---------- sender side ----------
  /** Split a file into frames. Returns { sid, total, header, frames: string[] }. */
  function buildFrames(bytes, meta, opts) {
    opts = opts || {};
    const chunkBytes = opts.chunkBytes || 300;
    const sid = opts.sid || randomSid();
    const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
    const frames = [];
    for (let i = 0; i < total; i++) {
      const chunk = bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes);
      frames.push([MAGIC_D, sid, i, total, b64encode(chunk)].join('|'));
    }
    const header = [MAGIC_H, sid, total, bytes.length, meta.sha256 || '',
      encodeURIComponent(meta.name || 'payload.bin'), meta.mime || 'application/octet-stream', chunkBytes].join('|');
    return { sid, total, header, frames, chunkBytes };
  }

  /** How many bytes of overhead a data frame has beyond the base64 payload, for sizing. */
  function dataFrameOverhead(sid, total) {
    return [MAGIC_D, sid || 'xxxxxx', total, total, ''].join('|').length;
  }

  /** Largest chunk (in raw bytes) that fits a QR of `qrCapacityBytes` text bytes. */
  function chunkBytesForCapacity(qrCapacityBytes, total) {
    const room = qrCapacityBytes - dataFrameOverhead(null, total || 9999);
    return Math.max(1, Math.floor(room / 4) * 3);
  }

  // ---------- receiver side ----------
  /** Parse a scanned string. Returns {type:'header'|'data', ...} or null if not a QRX frame. */
  function parseFrame(text) {
    if (typeof text !== 'string') return null;
    if (text.startsWith(MAGIC_D + '|')) {
      const parts = text.split('|');
      if (parts.length !== 5) return null;
      const idx = +parts[2], total = +parts[3];
      if (!Number.isInteger(idx) || !Number.isInteger(total) || idx < 0 || idx >= total) return null;
      let bytes;
      try { bytes = b64decode(parts[4]); } catch (e) { return null; }
      return { type: 'data', sid: parts[1], idx, total, bytes };
    }
    if (text.startsWith(MAGIC_H + '|')) {
      const parts = text.split('|');
      if (parts.length < 7) return null;
      return {
        type: 'header', sid: parts[1], total: +parts[2], size: +parts[3], sha256: parts[4],
        name: safeDecode(parts[5]), mime: parts[6] || 'application/octet-stream', chunkBytes: +(parts[7] || 0),
      };
    }
    return null;
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /** Stateful reassembler. feed(text) -> event object describing what changed. */
  function createReceiver() {
    const st = { sid: null, total: 0, chunks: new Map(), header: null, received: 0 };
    function reset(sid) { st.sid = sid; st.total = 0; st.chunks = new Map(); st.header = null; st.received = 0; }
    return {
      state: st,
      reset: () => reset(null),
      feed(text) {
        const f = parseFrame(text);
        if (!f) return { kind: 'ignored' };
        if (st.sid && f.sid !== st.sid) {
          // A new session appeared on screen: switch to it (old one is abandoned).
          reset(f.sid);
        } else if (!st.sid) reset(f.sid);
        if (f.type === 'header') {
          st.header = f; st.total = f.total;
          return { kind: 'header', header: f, complete: this.isComplete() };
        }
        st.total = st.total || f.total;
        if (st.chunks.has(f.idx)) return { kind: 'dup', idx: f.idx, complete: this.isComplete() };
        st.chunks.set(f.idx, f.bytes);
        st.received = st.chunks.size;
        return { kind: 'chunk', idx: f.idx, received: st.received, total: st.total, complete: this.isComplete() };
      },
      isComplete() { return st.total > 0 && st.chunks.size >= st.total; },
      missing() { const m = []; for (let i = 0; i < st.total; i++) if (!st.chunks.has(i)) m.push(i); return m; },
      assemble() {
        if (!this.isComplete()) throw new Error('incomplete');
        let len = 0; for (let i = 0; i < st.total; i++) len += st.chunks.get(i).length;
        const out = new Uint8Array(len); let o = 0;
        for (let i = 0; i < st.total; i++) { out.set(st.chunks.get(i), o); o += st.chunks.get(i).length; }
        return out;
      },
    };
  }

  async function sha256Hex(bytes) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const d = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return require('crypto').createHash('sha256').update(bytes).digest('hex');
  }

  return { MAGIC_H, MAGIC_D, b64encode, b64decode, randomSid, buildFrames, chunkBytesForCapacity,
    dataFrameOverhead, parseFrame, createReceiver, sha256Hex };
});

/*
 * qr-decoder.js — dependency-free QR Code decoder for camera frames (browser + Node).
 *
 * Pipeline (ZXing-style): grayscale → local-threshold binarize → find the three finder
 * patterns → estimate module size / dimension → locate the bottom-right alignment pattern →
 * perspective transform → sample the module grid → read format/version info → unmask →
 * read codewords → de-interleave → Reed–Solomon error correction → parse data segments.
 *
 * API:
 *   QRDecode.decodeGray(gray: Uint8Array, width, height, opts?) -> {text, bytes, version, ecl, mask} | null
 *   QRDecode.decodeImageData(imageData, opts?)                   -> same (RGBA → luma)
 * opts.tryInverted (default true): also try a light-on-dark code (terminals).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QRDecode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================ GF(256) + Reed–Solomon
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  const ginv = a => EXP[255 - LOG[a]];

  // Polynomials: coefficient arrays, highest degree first (as in ZXing's GenericGFPoly).
  function poly(coeffs) {
    let i = 0;
    while (i < coeffs.length - 1 && coeffs[i] === 0) i++;
    return i ? coeffs.slice(i) : coeffs;
  }
  const pdeg = p => p.length - 1;
  const pzero = p => p.length === 1 && p[0] === 0;
  const pcoef = (p, d) => p[p.length - 1 - d];
  function peval(p, a) {
    if (a === 0) return pcoef(p, 0);
    let r = 0;
    for (const c of p) r = gmul(r, a) ^ c;
    return r;
  }
  function padd(a, b) {
    if (pzero(a)) return b; if (pzero(b)) return a;
    let s = a, l = b; if (s.length > l.length) { s = b; l = a; }
    const out = new Array(l.length), diff = l.length - s.length;
    for (let i = 0; i < diff; i++) out[i] = l[i];
    for (let i = diff; i < l.length; i++) out[i] = s[i - diff] ^ l[i];
    return poly(out);
  }
  function pmul(a, b) {
    if (pzero(a) || pzero(b)) return [0];
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i], b[j]);
    return poly(out);
  }
  function pmulMono(p, degree, coef) {
    if (coef === 0) return [0];
    const out = new Array(p.length + degree).fill(0);
    for (let i = 0; i < p.length; i++) out[i] = gmul(p[i], coef);
    return poly(out);
  }
  function monomial(degree, coef) { if (coef === 0) return [0]; const o = new Array(degree + 1).fill(0); o[0] = coef; return o; }

  /** Correct `received` (data+ecc codewords) in place. Returns number of corrected errors or -1. */
  function rsDecode(received, twoS) {
    const syn = new Array(twoS).fill(0);
    let noError = true;
    const P = received;
    for (let i = 0; i < twoS; i++) {
      const e = peval(P, EXP[i]);
      syn[twoS - 1 - i] = e;
      if (e !== 0) noError = false;
    }
    if (noError) return 0;
    const S = poly(syn);
    // Euclidean algorithm
    let rLast = monomial(twoS, 1), r = S, tLast = [0], t = [1];
    if (pdeg(rLast) < pdeg(r)) { [rLast, r] = [r, rLast]; }
    while (pdeg(r) >= Math.floor(twoS / 2)) {
      const rLastLast = rLast, tLastLast = tLast;
      rLast = r; tLast = t;
      if (pzero(rLast)) return -1;
      r = rLastLast;
      let q = [0];
      const dlt = pcoef(rLast, pdeg(rLast)), dltInv = ginv(dlt);
      while (pdeg(r) >= pdeg(rLast) && !pzero(r)) {
        const dd = pdeg(r) - pdeg(rLast), scale = gmul(pcoef(r, pdeg(r)), dltInv);
        q = padd(q, monomial(dd, scale));
        r = padd(r, pmulMono(rLast, dd, scale));
      }
      t = padd(pmul(q, tLast), tLastLast);
      if (pdeg(r) >= pdeg(rLast)) return -1;
    }
    const s0 = pcoef(t, 0);
    if (s0 === 0) return -1;
    const inv = ginv(s0);
    const sigma = pmulMono(t, 0, inv), omega = pmulMono(r, 0, inv);
    // error locations
    const n = pdeg(sigma), locs = [];
    if (n === 1) locs.push(pcoef(sigma, 1));
    else for (let i = 1; i < 256 && locs.length < n; i++) if (peval(sigma, i) === 0) locs.push(ginv(i));
    if (locs.length !== n) return -1;
    // magnitudes (Forney, generator base 0)
    for (let i = 0; i < n; i++) {
      const xiInv = ginv(locs[i]);
      let denom = 1;
      for (let j = 0; j < n; j++) if (i !== j) {
        const term = gmul(locs[j], xiInv);
        denom = gmul(denom, (term & 1) === 0 ? term | 1 : term & ~1);
      }
      const mag = gmul(peval(omega, xiInv), ginv(denom));
      const pos = LOG[locs[i]];
      if (pos >= received.length) return -1;
      received[received.length - 1 - pos] ^= mag;
    }
    return n;
  }

  // ============================================================ QR version tables (shared with encoder)
  const ECC_CW = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const ECL_FROM_BITS = ['M', 'L', 'H', 'Q'];
  function rawCodewords(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
    return Math.floor(r / 8);
  }
  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const res = [6];
    for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }
  const fnCache = {};
  /** 1 where a module is a function pattern (finder, timing, alignment, format, version). */
  function functionMask(ver) {
    if (fnCache[ver]) return fnCache[ver];
    const size = ver * 4 + 17, m = new Uint8Array(size * size);
    const set = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) m[y * size + x] = 1; };
    for (let i = 0; i < size; i++) { set(6, i); set(i, 6); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) set(cx + dx, cy + dy); };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const ap = alignPositions(ver), n = ap.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy);
    }
    for (let i = 0; i <= 8; i++) { set(8, i); set(i, 8); }
    for (let i = 0; i < 8; i++) { set(size - 1 - i, 8); set(8, size - 1 - i); }
    if (ver >= 7) for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b); set(b, a); }
    return (fnCache[ver] = m);
  }
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];
  const FORMAT_TABLE = (() => {
    const t = [];
    for (let d = 0; d < 32; d++) { let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); t.push(((d << 10) | rem) ^ 0x5412); }
    return t;
  })();
  const VERSION_TABLE = (() => {
    const t = {};
    for (let v = 7; v <= 40; v++) { let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25); t[v] = (v << 12) | rem; }
    return t;
  })();
  const popcnt = n => { let c = 0; while (n) { n &= n - 1; c++; } return c; };

  // ============================================================ binarization (ZXing HybridBinarizer)
  function binarize(gray, w, h) {
    const BS = 8, sw = (w + BS - 1) >> 3, sh = (h + BS - 1) >> 3;
    const bp = new Int32Array(sw * sh);
    for (let by = 0; by < sh; by++) {
      const y0 = Math.min(by * BS, h - BS);
      for (let bx = 0; bx < sw; bx++) {
        const x0 = Math.min(bx * BS, w - BS);
        let sum = 0, min = 255, max = 0;
        for (let yy = 0; yy < BS; yy++) {
          const off = (y0 + yy) * w + x0;
          for (let xx = 0; xx < BS; xx++) { const p = gray[off + xx]; sum += p; if (p < min) min = p; if (p > max) max = p; }
        }
        let avg = sum >> 6;
        if (max - min <= 24) {
          avg = min >> 1;
          if (by > 0 && bx > 0) {
            const an = (bp[(by - 1) * sw + bx] + 2 * bp[by * sw + bx - 1] + bp[(by - 1) * sw + bx - 1]) >> 2;
            if (min < an) avg = an;
          }
        }
        bp[by * sw + bx] = avg;
      }
    }
    const bits = new Uint8Array(w * h);
    for (let by = 0; by < sh; by++) {
      const y0 = Math.min(by * BS, h - BS), top = Math.max(2, Math.min(by, sh - 3));
      for (let bx = 0; bx < sw; bx++) {
        const x0 = Math.min(bx * BS, w - BS), left = Math.max(2, Math.min(bx, sw - 3));
        let sum = 0;
        for (let z = -2; z <= 2; z++) { const row = (top + z) * sw; sum += bp[row + left - 2] + bp[row + left - 1] + bp[row + left] + bp[row + left + 1] + bp[row + left + 2]; }
        const thr = sum / 25;
        for (let yy = 0; yy < BS; yy++) {
          const off = (y0 + yy) * w + x0;
          for (let xx = 0; xx < BS; xx++) if (gray[off + xx] <= thr) bits[off + xx] = 1;
        }
      }
    }
    return bits;
  }

  // ============================================================ finder patterns
  function ratioOk(c) {
    const total = c[0] + c[1] + c[2] + c[3] + c[4];
    if (total < 14) return false;              // < 2 px/module is never decodable, only noise
    const ms = total / 7, v = ms / 2 + 0.75;   // +0.75px slack: small modules pixelate unevenly
    return Math.abs(ms - c[0]) < v && Math.abs(ms - c[1]) < v && Math.abs(3 * ms - c[2]) < 3 * v && Math.abs(ms - c[3]) < v && Math.abs(ms - c[4]) < v;
  }
  const centerFromEnd = (c, end) => end - c[4] - c[3] - c[2] / 2;

  const DBG = { hits: 0, vert: 0, horiz: 0, diag: 0 };
  function findFinders(bits, w, h) {
    const cands = []; DBG.hits = DBG.vert = DBG.horiz = DBG.diag = 0;
    const get = (x, y) => bits[y * w + x];
    function crossCheck(cx, cy, maxCount, dx, dy) {  // returns center along the scan axis or NaN
      const c = [0, 0, 0, 0, 0];
      let x = cx, y = cy;
      while (x >= 0 && y >= 0 && x < w && y < h && get(x, y)) { c[2]++; x -= dx; y -= dy; }
      if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
      while (x >= 0 && y >= 0 && x < w && y < h && !get(x, y) && c[1] <= maxCount) { c[1]++; x -= dx; y -= dy; }
      if (x < 0 || y < 0 || x >= w || y >= h || c[1] > maxCount) return NaN;
      while (x >= 0 && y >= 0 && x < w && y < h && get(x, y) && c[0] <= maxCount) { c[0]++; x -= dx; y -= dy; }
      if (c[0] > maxCount) return NaN;
      const start = dx ? x : y;
      x = cx + dx; y = cy + dy;
      while (x >= 0 && y >= 0 && x < w && y < h && get(x, y)) { c[2]++; x += dx; y += dy; }
      if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
      while (x >= 0 && y >= 0 && x < w && y < h && !get(x, y) && c[3] < maxCount) { c[3]++; x += dx; y += dy; }
      if (x < 0 || y < 0 || x >= w || y >= h || c[3] >= maxCount) return NaN;
      while (x >= 0 && y >= 0 && x < w && y < h && get(x, y) && c[4] < maxCount) { c[4]++; x += dx; y += dy; }
      if (c[4] >= maxCount) return NaN;
      const total = c[0] + c[1] + c[2] + c[3] + c[4];
      const end = dx ? x : y;
      return ratioOk(c) ? centerFromEnd(c, end) : NaN;
    }
    function crossCheckDiag(cx, cy) {
      const c = [0, 0, 0, 0, 0];
      let i = 0;
      while (cx >= i && cy >= i && get(cx - i, cy - i)) { c[2]++; i++; }
      if (cx < i || cy < i) return false;
      while (cx >= i && cy >= i && !get(cx - i, cy - i)) { c[1]++; i++; }
      if (cx < i || cy < i) return false;
      while (cx >= i && cy >= i && get(cx - i, cy - i)) { c[0]++; i++; }
      if (c[0] === 0) return false;
      i = 1;
      while (cx + i < w && cy + i < h && get(cx + i, cy + i)) { c[2]++; i++; }
      while (cx + i < w && cy + i < h && !get(cx + i, cy + i)) { c[3]++; i++; }
      if (c[3] === 0) return false;
      while (cx + i < w && cy + i < h && get(cx + i, cy + i)) { c[4]++; i++; }
      return ratioOk(c);
    }
    function handle(c, row, endCol) {
      const total = c[0] + c[1] + c[2] + c[3] + c[4];
      let cx = centerFromEnd(c, endCol);
      DBG.hits++;
      const cy = crossCheck(Math.round(cx), row, c[2], 0, 1);
      if (isNaN(cy)) { DBG.vert++; return false; }
      const cx0 = cx;
      cx = crossCheck(Math.round(cx0), Math.round(cy), c[2], 1, 0);
      if (isNaN(cx)) cx = crossCheck(Math.round(cx0), Math.round(cy) - 1, c[2], 1, 0);
      if (isNaN(cx)) cx = crossCheck(Math.round(cx0), Math.round(cy) + 1, c[2], 1, 0);
      if (isNaN(cx)) { DBG.horiz++; return false; }
      if (!crossCheckDiag(Math.round(cx), Math.round(cy))) { DBG.diag++; return false; }
      const ms = total / 7;
      for (const p of cands) {
        if (Math.abs(p.x - cx) <= ms && Math.abs(p.y - cy) <= ms && Math.abs(p.ms - ms) <= Math.max(1, p.ms * 0.5)) {
          p.x = (p.x * p.n + cx) / (p.n + 1); p.y = (p.y * p.n + cy) / (p.n + 1); p.ms = (p.ms * p.n + ms) / (p.n + 1); p.n++;
          return true;
        }
      }
      cands.push({ x: cx, y: cy, ms, n: 1 });
      return true;
    }
    DBG.crossCheck = crossCheck; DBG.handle = handle;
    const skip = 1;
    for (let y = skip; y < h; y += skip) {
      const c = [0, 0, 0, 0, 0];
      let state = 0;
      for (let x = 0; x < w; x++) {
        if (get(x, y)) {
          if (state & 1) state++;
          c[state]++;
        } else if (state & 1) c[state]++;
        else if (state === 4) {
          if (ratioOk(c)) handle(c, y, x);
          c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0; state = 3; continue;
        } else { c[++state]++; }
      }
      if (state === 4 && ratioOk(c)) handle(c, y, w);
    }
    return cands;
  }

  /** Pick the best triple of finder candidates and order them TL, TR, BL. */
  function chooseTriples(cands) {
    const list = cands.filter(c => c.n >= 2);
    const pool = (list.length >= 3 ? list : cands).slice().sort((a, b) => b.n - a.n).slice(0, 12);
    const triples = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
      const t = orderTriple(pool[i], pool[j], pool[k]);
      if (t) triples.push(t);
    }
    return triples.sort((a, b) => a.score - b.score).slice(0, 4);
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function orderTriple(p0, p1, p2) {
    const d01 = dist(p0, p1), d12 = dist(p1, p2), d02 = dist(p0, p2);
    let A, B, C;  // A = top-left (not on the longest side)
    if (d12 >= d01 && d12 >= d02) { A = p0; B = p1; C = p2; }
    else if (d02 >= d01 && d02 >= d12) { A = p1; B = p0; C = p2; }
    else { A = p2; B = p0; C = p1; }
    // cross((B-A),(C-A)) > 0 means B is top-right in image coordinates (y down)
    const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
    if (cross < 0) [B, C] = [C, B];
    const ab = dist(A, B), ac = dist(A, C), bc = dist(B, C);
    const ms = (A.ms + B.ms + C.ms) / 3;
    if (ab < ms * 10 || ac < ms * 10) return null;
    const msSpread = Math.max(A.ms, B.ms, C.ms) / Math.min(A.ms, B.ms, C.ms);
    if (msSpread > 2.2) return null;
    const rightAngle = Math.abs(bc * bc - (ab * ab + ac * ac)) / (bc * bc);   // 0 for a right angle
    const sides = Math.abs(ab - ac) / Math.max(ab, ac);
    if (rightAngle > 0.35 || sides > 0.35) return null;
    return { tl: A, tr: B, bl: C, ms, score: rightAngle + sides + (msSpread - 1) - (A.n + B.n + C.n) * 0.01 };
  }

  // ============================================================ perspective transform
  /** Homography from 4 source points (grid coords) to 4 destination points (image coords). */
  function homography(src, dst) {
    // Exact for 4 correspondences; least squares (normal equations) for more.
    const rows = [], rhs = [];
    for (let i = 0; i < src.length; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
    }
    const n = 8;
    let A, b;
    if (rows.length === 8) { A = rows; b = rhs; }
    else {
      A = Array.from({ length: n }, () => new Array(n).fill(0)); b = new Array(n).fill(0);
      for (let r = 0; r < rows.length; r++) for (let i = 0; i < n; i++) {
        b[i] += rows[r][i] * rhs[r];
        for (let k = 0; k < n; k++) A[i][k] += rows[r][i] * rows[r][k];
      }
    }
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = A[r][c] / A[c][c];
        if (f === 0) continue;
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hh = b.map((v, i) => v / A[i][i]);
    return (x, y) => {
      const den = hh[6] * x + hh[7] * y + 1;
      return [(hh[0] * x + hh[1] * y + hh[2]) / den, (hh[3] * x + hh[4] * y + hh[5]) / den];
    };
  }

  /**
   * Search the bottom-right alignment pattern around an estimated image position.
   * `ux`/`uy` are the local image-space vectors of one module step along the code's x and y
   * axes (from a provisional transform), so the 5×5 template follows rotation and perspective.
   */
  function findAlignment(bits, w, h, ex, ey, ux, uy, radiusModules) {
    const msLocal = (Math.hypot(ux[0], ux[1]) + Math.hypot(uy[0], uy[1])) / 2;
    const R = Math.max(2, Math.round(msLocal * radiusModules));
    const off = [-2, -1, 0, 1, 2];
    const score = (cx, cy) => {
      let sc = 0;
      for (const oy of off) for (const ox of off) {
        const px = Math.round(cx + ox * ux[0] + oy * uy[0]), py = Math.round(cy + ox * ux[1] + oy * uy[1]);
        if (px < 0 || py < 0 || px >= w || py >= h) return -99;
        const want = Math.max(Math.abs(ox), Math.abs(oy)) === 1 ? 0 : 1;
        if (bits[py * w + px] === want) sc++;
      }
      return sc;
    };
    // coarse pass
    const step = Math.max(1, Math.floor(msLocal / 2));
    let best = -1, bx = ex, by = ey;
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
      const sc = score(ex + dx, ey + dy);
      if (sc > best) { best = sc; bx = ex + dx; by = ey + dy; }
    }
    if (best < 21) return null;
    // fine pass: centroid of the best-scoring pixels around the coarse winner
    const F = Math.max(1, Math.round(msLocal));
    let bestF = -1, sx = 0, sy = 0, cnt = 0;
    for (let dy = -F; dy <= F; dy++) for (let dx = -F; dx <= F; dx++) {
      const sc = score(bx + dx, by + dy);
      if (sc > bestF) { bestF = sc; sx = bx + dx; sy = by + dy; cnt = 1; }
      else if (sc === bestF) { sx += bx + dx; sy += by + dy; cnt++; }
    }
    return bestF >= 22 ? { x: sx / cnt, y: sy / cnt, score: bestF } : null;
  }

  // ============================================================ grid sampling + decoding
  function sampleGrid(bits, w, h, tf, dim) {
    const m = new Uint8Array(dim * dim);
    for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) {
      const [px, py] = tf(x + 0.5, y + 0.5);
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
      m[y * dim + x] = bits[iy * w + ix];
    }
    return m;
  }

  function readFormat(m, dim) {
    const g = (x, y) => m[y * dim + x];
    let f1 = 0, f2 = 0;
    for (let i = 0; i <= 5; i++) f1 |= g(8, i) << i;
    f1 |= g(8, 7) << 6; f1 |= g(8, 8) << 7; f1 |= g(7, 8) << 8;
    for (let i = 9; i < 15; i++) f1 |= g(14 - i, 8) << i;
    for (let i = 0; i < 8; i++) f2 |= g(dim - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) f2 |= g(8, dim - 15 + i) << i;
    let best = -1, bestD = 99;
    for (let d = 0; d < 32; d++) {
      const dd = Math.min(popcnt(FORMAT_TABLE[d] ^ f1), popcnt(FORMAT_TABLE[d] ^ f2));
      if (dd < bestD) { bestD = dd; best = d; }
    }
    if (bestD > 3) return null;
    return { ecl: ECL_FROM_BITS[best >> 3], mask: best & 7 };
  }

  function readVersion(m, dim) {
    const g = (x, y) => m[y * dim + x];
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 18; i++) { const a = dim - 11 + i % 3, b = Math.floor(i / 3); v1 |= g(a, b) << i; v2 |= g(b, a) << i; }
    let best = -1, bestD = 99;
    for (let v = 7; v <= 40; v++) {
      const dd = Math.min(popcnt(VERSION_TABLE[v] ^ v1), popcnt(VERSION_TABLE[v] ^ v2));
      if (dd < bestD) { bestD = dd; best = v; }
    }
    return bestD <= 3 ? best : null;
  }

  function readCodewords(m, dim, ver, mask) {
    const fn = functionMask(ver), mf = MASKS[mask], total = rawCodewords(ver);
    const cw = new Uint8Array(total);
    let bi = 0;
    for (let right = dim - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < dim; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? dim - 1 - vert : vert;
        if (fn[y * dim + x] || bi >= total * 8) continue;
        let bit = m[y * dim + x];
        if (mf(x, y)) bit ^= 1;
        cw[bi >>> 3] |= bit << (7 - (bi & 7));
        bi++;
      }
    }
    return cw;
  }

  function correctAndExtract(cw, ver, ecl) {
    const nb = NUM_BLOCKS[ecl][ver], eccLen = ECC_CW[ecl][ver], total = rawCodewords(ver);
    const nShort = nb - total % nb, shortLen = Math.floor(total / nb), shortData = shortLen - eccLen;
    const blocks = [];
    for (let i = 0; i < nb; i++) blocks.push(new Uint8Array(shortData + (i < nShort ? 0 : 1) + eccLen));
    let k = 0;
    for (let i = 0; i < shortData; i++) for (let b = 0; b < nb; b++) blocks[b][i] = cw[k++];
    for (let b = nShort; b < nb; b++) blocks[b][shortData] = cw[k++];
    for (let i = 0; i < eccLen; i++) for (let b = 0; b < nb; b++) blocks[b][blocks[b].length - eccLen + i] = cw[k++];
    const data = [];
    let corrected = 0;
    for (const blk of blocks) {
      const arr = Array.from(blk);
      const r = rsDecode(arr, eccLen);
      if (r < 0) return null;
      corrected += r;
      for (let i = 0; i < arr.length - eccLen; i++) data.push(arr[i]);
    }
    return { data: new Uint8Array(data), corrected };
  }

  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function parseSegments(data, ver) {
    let pos = 0;
    const totalBits = data.length * 8;
    const rd = n => { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | ((data[pos >>> 3] >>> (7 - (pos & 7))) & 1); pos++; } return v >>> 0; };
    const out = [];
    while (pos + 4 <= totalBits) {
      const mode = rd(4);
      if (mode === 0) break;
      if (mode === 4) {           // byte
        const n = rd(ver <= 9 ? 8 : 16);
        if (pos + n * 8 > totalBits) return null;
        for (let i = 0; i < n; i++) out.push(rd(8));
      } else if (mode === 1) {    // numeric
        let n = rd(ver <= 9 ? 10 : ver <= 26 ? 12 : 14);
        while (n >= 3) { const v = rd(10); out.push(...String(v).padStart(3, '0').split('').map(c => c.charCodeAt(0))); n -= 3; }
        if (n === 2) { const v = rd(7); out.push(...String(v).padStart(2, '0').split('').map(c => c.charCodeAt(0))); }
        else if (n === 1) out.push(48 + rd(4));
      } else if (mode === 2) {    // alphanumeric
        let n = rd(ver <= 9 ? 9 : ver <= 26 ? 11 : 13);
        while (n >= 2) { const v = rd(11); out.push(ALNUM.charCodeAt(Math.floor(v / 45)), ALNUM.charCodeAt(v % 45)); n -= 2; }
        if (n === 1) out.push(ALNUM.charCodeAt(rd(6)));
      } else if (mode === 7) {    // ECI: skip designator
        const b = rd(8);
        if (b & 0x80) rd((b & 0x40) ? 16 : 8);
      } else if (mode === 3) rd(16);  // structured append
      else if (mode === 5 || mode === 9) { if (mode === 9) rd(8); }  // FNC1
      else return null;           // kanji etc. unsupported
    }
    return new Uint8Array(out);
  }

  // ============================================================ top level
  function decodeBits(bits, w, h) {
    const cands = findFinders(bits, w, h);
    if (cands.length < 3) return null;
    for (const t of chooseTriples(cands)) {
      const res = decodeFromTriple(bits, w, h, t);
      if (res) return res;
    }
    return null;
  }

  /** Score a candidate dimension by how well the timing patterns alternate under it. */
  function timingScore(bits, w, h, tl, tr, bl, dim) {
    const tf = homography([[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], [dim - 3.5, dim - 3.5]],
      [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y]]);
    if (!tf) return -1;
    let ok = 0, n = 0;
    for (let i = 8; i < dim - 8; i++) {
      for (const [x, y] of [[i + 0.5, 6.5], [6.5, i + 0.5]]) {
        const [px, py] = tf(x, y), ix = Math.round(px), iy = Math.round(py);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) return -1;
        n++;
        if (bits[iy * w + ix] === (i % 2 === 0 ? 1 : 0)) ok++;
      }
    }
    return n ? ok / n : -1;
  }

  function decodeFromTriple(bits, w, h, t) {
    const { tl, tr, bl } = t;
    const ms = (tl.ms + tr.ms + bl.ms) / 3;
    const estDim = Math.round((dist(tl, tr) + dist(tl, bl)) / 2 / ms) + 7;
    // Finder-based module size is unreliable under blur/perspective, so rank every plausible
    // dimension by its timing-pattern fit and try the best few.
    const lo = Math.max(21, Math.floor(estDim * 0.55)), hi = Math.min(177, Math.ceil(estDim * 1.6));
    const scored = [];
    for (let dim = 21; dim <= 177; dim += 4) {
      if (dim < lo || dim > hi) continue;
      scored.push({ dim, s: timingScore(bits, w, h, tl, tr, bl, dim) - Math.abs(dim - estDim) * 0.002 });
    }
    scored.sort((a, b) => b.s - a.s);
    // Order of attempts: confident timing matches first, then the finder-based estimate and its
    // neighbours (the alignment search fixes moderate perspective), then whatever is left.
    const order = [];
    const push = d => { if (d >= 21 && d <= 177 && (d & 3) === 1 && !order.includes(d)) order.push(d); };
    for (const { dim, s } of scored) if (s >= 0.8) push(dim);
    const snap = d => { const r = d & 3; return r === 1 ? d : r === 0 ? d + 1 : r === 2 ? d - 1 : d + 2; };
    for (const d of [0, 4, -4, 8, -8]) push(snap(estDim) + d);
    for (const { dim } of scored.slice(0, 3)) push(dim);
    for (const dim of order.slice(0, 7)) {
      const res = decodeWithDim(bits, w, h, tl, tr, bl, ms, dim);
      if (res) return res;
    }
    return null;
  }

  function decodeWithDim(bits, w, h, tl, tr, bl, ms, dim) {
    const ver = (dim - 17) / 4;
    const srcTL = [3.5, 3.5], srcTR = [dim - 3.5, 3.5], srcBL = [3.5, dim - 3.5];
    let brSrc = [dim - 3.5, dim - 3.5];
    let brDst = [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y];
    if (ver > 1) {
      // estimate the alignment centre with an affine model, then search around it
      const a = dim - 6.5, f = (a - 3.5) / (dim - 7);
      const ex = tl.x + (tr.x - tl.x) * f + (bl.x - tl.x) * f, ey = tl.y + (tr.y - tl.y) * f + (bl.y - tl.y) * f;
      // refine via a provisional homography (handles perspective better than affine)
      const tf0 = homography([srcTL, srcTR, srcBL, brSrc], [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], brDst]);
      const [hx, hy] = tf0 ? tf0(a, a) : [ex, ey];
      const p0 = tf0 ? tf0(a, a) : [ex, ey], px1 = tf0 ? tf0(a + 1, a) : [ex + ms, ey], py1 = tf0 ? tf0(a, a + 1) : [ex, ey + ms];
      const ux = [px1[0] - p0[0], px1[1] - p0[1]], uy = [py1[0] - p0[0], py1[1] - p0[1]];
      const al = findAlignment(bits, w, h, Math.round(hx), Math.round(hy), ux, uy, 4) || findAlignment(bits, w, h, Math.round(hx), Math.round(hy), ux, uy, 10);
      if (al) { brSrc = [a, a]; brDst = [al.x, al.y]; }
    }
    let tf = homography([srcTL, srcTR, srcBL, brSrc], [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], brDst]);
    if (!tf) return null;
    if (ver >= 7) {
      // Larger symbols: locate every alignment pattern and refit the transform by least squares,
      // which absorbs lens distortion and screen curvature that one corner point cannot.
      const ap = alignPositions(ver), n = ap.length, srcs = [srcTL, srcTR, srcBL], dsts = [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y]];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        const cx = ap[i] + 0.5, cy = ap[j] + 0.5;
        const p0 = tf(cx, cy), px1 = tf(cx + 1, cy), py1 = tf(cx, cy + 1);
        const al = findAlignment(bits, w, h, Math.round(p0[0]), Math.round(p0[1]), [px1[0] - p0[0], px1[1] - p0[1]], [py1[0] - p0[0], py1[1] - p0[1]], 2.5);
        if (al && al.score >= 23) { srcs.push([cx, cy]); dsts.push([al.x, al.y]); }
      }
      if (srcs.length >= 5) tf = homography(srcs, dsts) || tf;
    }
    const m = sampleGrid(bits, w, h, tf, dim);
    if (!m) return null;
    if (ver >= 7) {
      const v = readVersion(m, dim);
      if (v !== null && v !== ver) return null;   // let the right dimension be tried instead
    }
    const fmt = readFormat(m, dim);
    if (!fmt) return null;
    const cw = readCodewords(m, dim, ver, fmt.mask);
    const ce = correctAndExtract(cw, ver, fmt.ecl);
    if (!ce) return null;
    const bytes = parseSegments(ce.data, ver);
    if (!bytes) return null;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) { text = String.fromCharCode.apply(null, bytes); }
    return { text, bytes, version: ver, ecl: fmt.ecl, mask: fmt.mask, corrected: ce.corrected,
      corners: [tf(0, 0), tf(dim, 0), tf(dim, dim), tf(0, dim)] };
  }

  function decodeGray(gray, w, h, opts) {
    opts = opts || {};
    const bits = binarize(gray, w, h);
    let r = decodeBits(bits, w, h);
    if (!r && opts.tryInverted !== false) {
      for (let i = 0; i < bits.length; i++) bits[i] ^= 1;
      r = decodeBits(bits, w, h);
      if (r) r.inverted = true;
    }
    return r;
  }

  function decodeImageData(img, opts) {
    const { data, width, height } = img;
    const gray = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
    return decodeGray(gray, width, height, opts);
  }

  return { decodeGray, decodeImageData, binarize, rsDecode,
    _internals: { DBG, timingScore, findFinders, chooseTriples, homography, sampleGrid, readFormat, readVersion, readCodewords, correctAndExtract, parseSegments, findAlignment } };
});

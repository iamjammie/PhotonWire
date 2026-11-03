/*
 * qr-encoder.js — dependency-free QR Code encoder (byte mode, versions 1–40, EC L/M/Q/H).
 *
 * Works in the browser (window.QR) and in Node (module.exports). No network, no deps —
 * safe to copy onto an air-gapped machine.
 *
 * API:
 *   QR.encodeBytes(bytes: Uint8Array, ecl: 'L'|'M'|'Q'|'H', opts?) -> { version, size, mask, get(x,y) }
 *   QR.encodeText(str, ecl, opts)          // UTF-8 encodes then calls encodeBytes
 *   QR.maxBytes(version, ecl)              // byte-mode payload capacity of a version
 *   QR.drawToCanvas(code, canvas, { scale, quiet })
 *   QR.toSVG(code, { quiet })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- tables (index = version, 0 unused) ----------
  const ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const NUM_ERROR_CORRECTION_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

  // ---------- capacity helpers ----------
  function numRawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      r -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }
  function byteCountBits(ver) { return ver <= 9 ? 8 : 16; }
  function maxBytes(ver, ecl) {
    return Math.floor((numDataCodewords(ver, ecl) * 8 - 4 - byteCountBits(ver)) / 8);
  }

  // ---------- Reed–Solomon over GF(2^8), poly 0x11D ----------
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
  }

  // ---------- bit buffer ----------
  function appendBits(buf, val, len) {
    for (let i = len - 1; i >= 0; i--) buf.push((val >>> i) & 1);
  }

  // ---------- main encode ----------
  function encodeBytes(bytes, ecl, opts) {
    ecl = (ecl || 'M').toUpperCase();
    if (!(ecl in ECL_FORMAT_BITS)) throw new Error('Bad EC level ' + ecl);
    opts = opts || {};
    const minVer = opts.minVersion || 1, maxVer = opts.maxVersion || 40;
    let version = -1;
    for (let v = minVer; v <= maxVer; v++) {
      if (maxBytes(v, ecl) >= bytes.length) { version = v; break; }
    }
    if (version < 0) throw new Error('Data too long: ' + bytes.length + ' bytes');

    // Segment: byte mode
    const bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, byteCountBits(version));
    for (const b of bytes) appendBits(bits, b, 8);

    const dataCapBits = numDataCodewords(version, ecl) * 8;
    appendBits(bits, 0, Math.min(4, dataCapBits - bits.length));
    appendBits(bits, 0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < dataCapBits; pad ^= 0xEC ^ 0x11) appendBits(bits, pad, 8);

    const dataCodewords = new Uint8Array(bits.length / 8);
    bits.forEach((b, i) => { dataCodewords[i >>> 3] |= b << (7 - (i & 7)); });

    const size = version * 4 + 17;
    const modules = [], isFunction = [];
    for (let y = 0; y < size; y++) { modules.push(new Uint8Array(size)); isFunction.push(new Uint8Array(size)); }

    const setFn = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; isFunction[y][x] = 1; };

    // --- function patterns ---
    function drawFinder(cx, cy) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
    function drawAlign(cx, cy) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function alignPositions() {
      if (version === 1) return [];
      const numAlign = Math.floor(version / 7) + 2;
      const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
      const res = [6];
      for (let pos = size - 7; res.length < numAlign; pos -= step) res.splice(1, 0, pos);
      return res;
    }
    function drawFormatBits(mask) {
      const data = ECL_FORMAT_BITS[ecl] << 3 | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = (data << 10 | rem) ^ 0x5412;
      const bit = i => (b >>> i) & 1;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, 1);
    }
    function drawVersion() {
      if (version < 7) return;
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const b = version << 12 | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (b >>> i) & 1, a = size - 11 + i % 3, c = Math.floor(i / 3);
        setFn(a, c, bit); setFn(c, a, bit);
      }
    }
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);
    const ap = alignPositions(), n = ap.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlign(ap[i], ap[j]);
    }
    drawFormatBits(0);
    drawVersion();

    // --- error correction + interleave ---
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
    const rawCodewords = Math.floor(numRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const rsDiv = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = dataCodewords.slice(k, k + datLen);
      k += datLen;
      const ecc = rsRemainder(dat, rsDiv);
      const block = new Uint8Array(shortBlockLen + 1);
      block.set(dat); block.set(ecc, shortBlockLen + 1 - blockEccLen);
      blocks.push(block);
    }
    const allCodewords = new Uint8Array(rawCodewords);
    let k = 0;
    for (let i = 0; i < blocks[0].length; i++) for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) allCodewords[k++] = blocks[j][i];
    }

    // --- place codewords (zigzag) ---
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bi < allCodewords.length * 8) {
          modules[y][x] = (allCodewords[bi >>> 3] >>> (7 - (bi & 7))) & 1;
          bi++;
        }
      }
    }

    // --- masking ---
    const maskFns = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
      (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    function applyMask(m) {
      const f = maskFns[m];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (!isFunction[y][x] && f(x, y)) modules[y][x] ^= 1;
    }
    function penalty() {
      let score = 0;
      const finderPat = [1, 0, 1, 1, 1, 0, 1];
      const countFinder = (line) => {
        let c = 0;
        for (let i = 0; i + 7 <= line.length; i++) {
          let ok = true;
          for (let j = 0; j < 7; j++) if (line[i + j] !== finderPat[j]) { ok = false; break; }
          if (!ok) continue;
          const lightBefore = i >= 4 && line.slice(i - 4, i).every(v => v === 0);
          const lightAfter = i + 11 <= line.length && line.slice(i + 7, i + 11).every(v => v === 0);
          if (lightBefore || lightAfter) c++;
        }
        return c;
      };
      for (let y = 0; y < size; y++) {
        const row = modules[y], col = new Uint8Array(size);
        for (let x = 0; x < size; x++) col[x] = modules[x][y];
        for (const line of [row, col]) {
          let run = 1;
          for (let i = 1; i < size; i++) {
            if (line[i] === line[i - 1]) { run++; if (run === 5) score += PENALTY.N1; else if (run > 5) score++; }
            else run = 1;
          }
          score += countFinder(line) * PENALTY.N3;
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += PENALTY.N2;
      }
      let dark = 0;
      for (const row of modules) for (const v of row) dark += v;
      const total = size * size;
      const kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      score += kk * PENALTY.N4;
      return score;
    }

    let mask = opts.mask;
    if (mask === undefined || mask < 0) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormatBits(m);
        const p = penalty();
        if (p < best) { best = p; mask = m; }
        applyMask(m);
      }
    }
    applyMask(mask); drawFormatBits(mask);

    return {
      version, size, mask, ecl,
      modules,
      get: (x, y) => (x >= 0 && y >= 0 && x < size && y < size) ? modules[y][x] === 1 : false,
    };
  }

  function encodeText(str, ecl, opts) {
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(str) : Uint8Array.from(Buffer.from(str, 'utf8'));
    return encodeBytes(bytes, ecl, opts);
  }

  function drawToCanvas(code, canvas, opts) {
    opts = opts || {};
    const quiet = opts.quiet === undefined ? 4 : opts.quiet;
    const total = code.size + quiet * 2;
    const scale = opts.scale || Math.max(1, Math.floor((opts.pixels || 640) / total));
    canvas.width = canvas.height = total * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.dark || '#000';
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++)
      if (code.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    return canvas;
  }

  function toSVG(code, opts) {
    opts = opts || {};
    const quiet = opts.quiet === undefined ? 4 : opts.quiet;
    const total = code.size + quiet * 2;
    let d = '';
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++)
      if (code.modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { encodeBytes, encodeText, maxBytes, drawToCanvas, toSVG, numDataCodewords };
});

/**
 * A QR encoder, just large enough for a join link.
 *
 * Typing DKCA-DEDX-EFEX into a television remote is the worst part of using
 * this app, and every competitor solves it with a QR code. This encodes byte
 * mode at error-correction level M, versions 1 to 6 — up to 106 bytes, where a
 * join link is about sixty. Anything longer throws rather than silently
 * producing a code that will not scan.
 *
 * Level M recovers about 15% of a damaged code, which is the right trade for
 * something photographed off a screen at an angle: higher levels make the code
 * denser, and density is what actually defeats a phone camera across a room.
 *
 * Written out rather than depended on because the whole server has one
 * dependency, and because a wrong QR fails at the moment it is needed most —
 * this one is checked against the browser's own decoder in the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Qr = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── The tables ─────────────────────────────────────────────────────────── */

  /*
   * Per version at level M: how many error-correction codewords each block
   * carries, and how many data codewords are in each block. Splitting into
   * blocks is what lets a scratch across the middle of a code lose only part of
   * one block rather than ruining everything.
   */
  const VERSIONS = {
    1: { ec: 10, blocks: [16] },
    2: { ec: 16, blocks: [28] },
    3: { ec: 26, blocks: [44] },
    4: { ec: 18, blocks: [32, 32] },
    5: { ec: 24, blocks: [43, 43] },
    6: { ec: 16, blocks: [27, 27, 27, 27] },
  };

  // Where the smaller alignment squares sit, as centre coordinates.
  const ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  };

  // Bits left over after the codewords, which are simply padded with zeros.
  const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };

  const EC_LEVEL_M = 0b00;          // the level-M bit pattern used in format info
  // Version 6 at level M holds 108 data codewords, two of which are spent on
  // the mode and length header.
  const MAX_BYTES = 106;

  /* ── Arithmetic in GF(256) ──────────────────────────────────────────────── */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;    // the primitive polynomial QR uses
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  }());

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** The generator polynomial for `count` error-correction codewords. */
  function generator(count) {
    let poly = [1];
    for (let i = 0; i < count; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** Polynomial long division; the remainder is the error correction. */
  function errorCorrection(data, count) {
    const gen = generator(count);
    const remainder = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      for (let i = 0; i < count; i += 1) remainder[i] ^= mul(gen[i + 1], factor);
    }
    return remainder;
  }

  /* ── Turning text into codewords ────────────────────────────────────────── */

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  function pickVersion(byteCount) {
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const capacity = VERSIONS[version].blocks.reduce((a, b) => a + b, 0);
      // 4 bits of mode + 8 bits of length, so two whole codewords of header.
      if (byteCount + 2 <= capacity) return version;
    }
    throw new Error(`That is ${byteCount} bytes; a QR code here holds ${MAX_BYTES}.`);
  }

  function codewords(bytes, version) {
    const { blocks } = VERSIONS[version];
    const capacity = blocks.reduce((a, b) => a + b, 0);

    const bits = [];
    const push = (value, width) => {
      for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
    };

    push(0b0100, 4);                    // byte mode
    push(bytes.length, 8);              // one byte of length, for versions 1–9
    for (const byte of bytes) push(byte, 8);

    // Terminator, then out to a whole codeword.
    for (let i = 0; i < 4 && bits.length < capacity * 8; i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
    }
    // The two pad bytes the specification names, alternating.
    for (let i = 0; out.length < capacity; i += 1) out.push(i % 2 ? 0x11 : 0xEC);
    return out;
  }

  /**
   * Split into blocks, add error correction, then interleave.
   *
   * Interleaving is the point of the exercise: a run of damage in the finished
   * code lands one byte in each block rather than wiping out a single block.
   */
  function interleave(data, version) {
    const { ec, blocks } = VERSIONS[version];
    const dataBlocks = [];
    const ecBlocks = [];
    let at = 0;
    for (const size of blocks) {
      const block = data.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(errorCorrection(block, ec));
    }

    const out = [];
    const longest = Math.max(...blocks);
    for (let i = 0; i < longest; i += 1) {
      for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
    }
    for (let i = 0; i < ec; i += 1) {
      for (const block of ecBlocks) out.push(block[i]);
    }
    return out;
  }

  /* ── Drawing the matrix ─────────────────────────────────────────────────── */

  function blank(size) {
    return {
      size,
      cells: Array.from({ length: size }, () => new Uint8Array(size)),
      fixed: Array.from({ length: size }, () => new Uint8Array(size)),
    };
  }

  function set(m, x, y, dark, isFixed) {
    m.cells[y][x] = dark ? 1 : 0;
    if (isFixed) m.fixed[y][x] = 1;
  }

  function finder(m, x0, y0) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
        const ring = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const outer = ring && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        set(m, x, y, outer || core, true);
      }
    }
  }

  function skeleton(version) {
    const size = 17 + version * 4;
    const m = blank(size);

    finder(m, 0, 0);
    finder(m, size - 7, 0);
    finder(m, 0, size - 7);

    // Timing rows, which give a scanner its grid.
    for (let i = 8; i < size - 8; i += 1) {
      set(m, i, 6, i % 2 === 0, true);
      set(m, 6, i, i % 2 === 0, true);
    }

    const centres = ALIGNMENT[version];
    for (const cy of centres) {
      for (const cx of centres) {
        // Not where the finders already are.
        if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const edge = Math.max(Math.abs(dx), Math.abs(dy));
            set(m, cx + dx, cy + dy, edge !== 1, true);
          }
        }
      }
    }

    set(m, 8, size - 8, true, true);        // the one module that is always dark

    // Reserve the format-information strips; their values come later.
    for (let i = 0; i < 9; i += 1) {
      if (i !== 6) { m.fixed[8][i] = 1; m.fixed[i][8] = 1; }
    }
    for (let i = 0; i < 8; i += 1) {
      m.fixed[8][size - 1 - i] = 1;
      m.fixed[size - 1 - i][8] = 1;
    }
    return m;
  }

  /** Lay the codewords out in the up-and-down snake the specification defines. */
  function placeData(m, bytes, remainder) {
    const bits = [];
    for (const byte of bytes) {
      for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
    }
    for (let i = 0; i < remainder; i += 1) bits.push(0);

    let at = 0;
    let upward = true;
    for (let right = m.size - 1; right > 0; right -= 2) {
      const col = right === 6 ? right - 1 : right;   // the timing column is skipped
      for (let step = 0; step < m.size; step += 1) {
        const y = upward ? m.size - 1 - step : step;
        for (const x of [col, col - 1]) {
          if (m.fixed[y][x]) continue;
          m.cells[y][x] = at < bits.length ? bits[at] : 0;
          at += 1;
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (y, x) => (y + x) % 2 === 0,
    (y) => y % 2 === 0,
    (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0,
    (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y, x) => ((((y * x) % 2) + ((y * x) % 3)) % 2) === 0,
    (y, x) => ((((y + x) % 2) + ((y * x) % 3)) % 2) === 0,
  ];

  /*
   * The four penalties the specification defines, which together choose a mask.
   * They exist to avoid patterns a scanner could mistake for a finder, and to
   * keep light and dark roughly balanced.
   */
  function penalty(m) {
    const { size, cells } = m;
    let score = 0;

    const run = (get) => {
      for (let a = 0; a < size; a += 1) {
        let last = -1;
        let length = 0;
        for (let b = 0; b < size; b += 1) {
          const value = get(a, b);
          if (value === last) {
            length += 1;
            if (length === 5) score += 3;
            else if (length > 5) score += 1;
          } else { last = value; length = 1; }
        }
      }
    };
    run((y, x) => cells[y][x]);
    run((x, y) => cells[y][x]);

    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const v = cells[y][x];
        if (v === cells[y][x + 1] && v === cells[y + 1][x] && v === cells[y + 1][x + 1]) score += 3;
      }
    }

    const BAD = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const BAD_REVERSED = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (get, a, b, pattern) => pattern.every((bit, i) => get(a, b + i) === bit);
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b + 11 <= size; b += 1) {
        const row = (p, q) => cells[p][q];
        const col = (p, q) => cells[q][p];
        if (matches(row, a, b, BAD) || matches(row, a, b, BAD_REVERSED)) score += 40;
        if (matches(col, a, b, BAD) || matches(col, a, b, BAD_REVERSED)) score += 40;
      }
    }

    let dark = 0;
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) dark += cells[y][x];
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  /** Format information: five bits of level and mask, protected by BCH. */
  function formatBits(mask) {
    const value = (EC_LEVEL_M << 3) | mask;
    let bch = value << 10;
    for (let i = 14; i >= 10; i -= 1) {
      if ((bch >> i) & 1) bch ^= 0b10100110111 << (i - 10);
    }
    return ((value << 10) | bch) ^ 0b101010000010010;
  }

  function placeFormat(m, mask) {
    const bits = formatBits(mask);
    const size = m.size;
    const bit = (i) => (bits >> i) & 1;

    for (let i = 0; i <= 5; i += 1) set(m, 8, i, bit(i), true);
    set(m, 8, 7, bit(6), true);
    set(m, 8, 8, bit(7), true);
    set(m, 7, 8, bit(8), true);
    for (let i = 9; i <= 14; i += 1) set(m, 14 - i, 8, bit(i), true);

    for (let i = 0; i <= 7; i += 1) set(m, size - 1 - i, 8, bit(i), true);
    for (let i = 8; i <= 14; i += 1) set(m, 8, size - 15 + i, bit(i), true);
  }

  /* ── The public shape ───────────────────────────────────────────────────── */

  /** Encode text; returns `{ version, size, cells }` where a 1 is a dark module. */
  function encode(text) {
    const bytes = utf8(String(text));
    const version = pickVersion(bytes.length);
    const payload = interleave(codewords(bytes, version), version);

    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      const m = skeleton(version);
      placeData(m, payload, REMAINDER[version]);
      for (let y = 0; y < m.size; y += 1) {
        for (let x = 0; x < m.size; x += 1) {
          if (!m.fixed[y][x] && MASKS[mask](y, x)) m.cells[y][x] ^= 1;
        }
      }
      placeFormat(m, mask);
      const score = penalty(m);
      if (!best || score < best.score) best = { score, mask, m };
    }

    return {
      version,
      mask: best.mask,
      size: best.m.size,
      cells: best.m.cells,
    };
  }

  /**
   * The same thing as an SVG.
   *
   * Drawn as one path of little squares rather than thousands of rects, and
   * with the four-module quiet zone a scanner needs — a QR pressed right to the
   * edge of its container often will not read.
   */
  function svg(text, { scale = 8, quiet = 4, dark = '#2A2440', light = '#FFFFFF' } = {}) {
    const { cells, size } = encode(text);
    const span = size + quiet * 2;
    const parts = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (cells[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}"`
      + ` width="${span * scale}" height="${span * scale}" shape-rendering="crispEdges"`
      + ' role="img" aria-label="QR code to join this slideshow">'
      + `<rect width="${span}" height="${span}" fill="${light}"/>`
      + `<path d="${parts.join('')}" fill="${dark}"/></svg>`;
  }

  return { encode, svg, MAX_BYTES };
});

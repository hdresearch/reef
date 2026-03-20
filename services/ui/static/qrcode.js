/**
 * Minimal QR Code generator — pure JS, no dependencies.
 * Generates QR codes as SVG strings. Supports up to ~200 chars (version 1-10).
 *
 * Based on the QR code specification (ISO/IEC 18004).
 * Only supports byte mode, error correction level M.
 */

const QR = (() => {
  // GF(256) math for Reed-Solomon
  const EXP = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  EXP[255] = EXP[0];

  function gfMul(a, b) { return a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0; }

  function polyMul(a, b) {
    const r = new Uint8Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++)
        r[i + j] ^= gfMul(a[i], b[j]);
    return r;
  }

  function rsEncode(data, ecLen) {
    let gen = new Uint8Array([1]);
    for (let i = 0; i < ecLen; i++)
      gen = polyMul(gen, new Uint8Array([1, EXP[i]]));
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef) for (let j = 0; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], coef);
    }
    return msg.slice(data.length);
  }

  // Version info: [version, size, dataCodewords, ecCodewordsPerBlock, numBlocks]
  // Error correction level M
  const VERSIONS = [
    null,
    [1, 21, 16, 10, 1],
    [2, 25, 28, 16, 1],
    [3, 29, 44, 26, 1],
    [4, 33, 64, 18, 2],
    [5, 37, 86, 24, 2],
    [6, 41, 108, 16, 4],
    [7, 45, 124, 18, 4],
    [8, 49, 154, 22, 4],   // adjusted: 4 blocks
    [9, 53, 182, 22, 4],   // adjusted: split blocks
    [10, 57, 216, 26, 4],  // adjusted: split blocks
  ];

  function chooseVersion(byteLen) {
    // Byte mode: 4 bits mode + char count bits + data + terminator
    for (let v = 1; v <= 10; v++) {
      const info = VERSIONS[v];
      const charCountBits = v <= 9 ? 8 : 16;
      const dataBits = info[2] * 8;
      const needed = 4 + charCountBits + byteLen * 8;
      if (needed <= dataBits) return v;
    }
    return -1; // too long
  }

  function encodeData(bytes, version) {
    const info = VERSIONS[version];
    const totalDataCW = info[2];
    const charCountBits = version <= 9 ? 8 : 16;

    // Build bit string
    let bits = '';
    // Mode: byte = 0100
    bits += '0100';
    // Character count
    bits += bytes.length.toString(2).padStart(charCountBits, '0');
    // Data
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    // Terminator (up to 4 zeros)
    const cap = totalDataCW * 8;
    bits += '0000'.slice(0, Math.min(4, cap - bits.length));
    // Pad to byte boundary
    while (bits.length % 8) bits += '0';
    // Pad codewords
    const pads = [0xec, 0x11];
    let pi = 0;
    while (bits.length < cap) {
      bits += pads[pi].toString(2).padStart(8, '0');
      pi ^= 1;
    }

    const data = new Uint8Array(totalDataCW);
    for (let i = 0; i < totalDataCW; i++)
      data[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);

    return data;
  }

  function interleaveBlocks(data, version) {
    const info = VERSIONS[version];
    const ecPerBlock = info[3];
    const numBlocks = info[4];
    const totalDataCW = info[2];
    const cwPerBlock = Math.floor(totalDataCW / numBlocks);
    const remainder = totalDataCW % numBlocks;

    const blocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let b = 0; b < numBlocks; b++) {
      const size = cwPerBlock + (b >= numBlocks - remainder ? 1 : 0);
      const block = data.slice(offset, offset + size);
      blocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
      offset += size;
    }

    // Interleave data
    const result = [];
    const maxDataLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxDataLen; i++)
      for (const block of blocks)
        if (i < block.length) result.push(block[i]);
    // Interleave EC
    for (let i = 0; i < ecPerBlock; i++)
      for (const block of ecBlocks)
        if (i < block.length) result.push(block[i]);

    return new Uint8Array(result);
  }

  // Alignment pattern positions by version
  const ALIGN_POS = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
  ];

  // Format info bits for mask 0-7, EC level M (01)
  const FORMAT_BITS = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  ];

  function createMatrix(version) {
    const size = VERSIONS[version][1];
    // 0 = unset, 1 = black-data, 2 = white-data, 3 = black-fixed, 4 = white-fixed
    const matrix = Array.from({ length: size }, () => new Uint8Array(size));

    // Finder patterns
    function finderPattern(r, c) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const dark = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                       (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                       (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          matrix[rr][cc] = dark ? 3 : 4;
        }
      }
    }
    finderPattern(0, 0);
    finderPattern(0, size - 7);
    finderPattern(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      if (!matrix[6][i]) matrix[6][i] = (i % 2 === 0) ? 3 : 4;
      if (!matrix[i][6]) matrix[i][6] = (i % 2 === 0) ? 3 : 4;
    }

    // Alignment patterns
    const positions = ALIGN_POS[version];
    if (positions.length) {
      for (const r of positions) {
        for (const c of positions) {
          if (matrix[r][c]) continue; // skip if overlaps finder
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
              matrix[r + dr][c + dc] = dark ? 3 : 4;
            }
          }
        }
      }
    }

    // Dark module
    matrix[size - 8][8] = 3;

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (!matrix[8][i]) matrix[8][i] = 4;
      if (!matrix[8][size - 1 - i]) matrix[8][size - 1 - i] = 4;
      if (!matrix[i][8]) matrix[i][8] = 4;
      if (!matrix[size - 1 - i][8]) matrix[size - 1 - i][8] = 4;
    }
    if (!matrix[8][8]) matrix[8][8] = 4;

    return matrix;
  }

  function placeData(matrix, codewords) {
    const size = matrix.length;
    let bitIdx = 0;
    const totalBits = codewords.length * 8;

    // Traverse right-to-left in 2-column strips, bottom-to-top then top-to-bottom
    let col = size - 1;
    while (col >= 0) {
      if (col === 6) col--; // skip timing column
      const upward = ((size - 1 - col) >> 1) % 2 === 0;
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (const dc of [0, -1]) {
          const c = col + dc;
          if (c < 0) continue;
          if (matrix[row][c]) continue; // already set (fixed pattern)
          const dark = bitIdx < totalBits && ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1);
          matrix[row][c] = dark ? 1 : 2;
          bitIdx++;
        }
      }
      col -= 2;
    }
  }

  // Mask functions
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  function applyMask(matrix, maskIdx) {
    const size = matrix.length;
    const result = matrix.map(row => row.slice());
    const fn = MASKS[maskIdx];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (result[r][c] <= 2 && result[r][c] > 0) {
          const isDark = result[r][c] === 1;
          if (fn(r, c)) result[r][c] = isDark ? 2 : 1;
        }
      }
    }
    return result;
  }

  function writeFormatInfo(matrix, maskIdx) {
    const size = matrix.length;
    const bits = FORMAT_BITS[maskIdx];
    // Around top-left finder
    for (let i = 0; i < 6; i++) matrix[8][i] = (bits >> (14 - i)) & 1 ? 3 : 4;
    matrix[8][7] = (bits >> 8) & 1 ? 3 : 4;
    matrix[8][8] = (bits >> 7) & 1 ? 3 : 4;
    matrix[7][8] = (bits >> 6) & 1 ? 3 : 4;
    for (let i = 0; i < 6; i++) matrix[5 - i][8] = (bits >> (i)) & 1 ? 3 : 4;
    // Around bottom-left and top-right finders
    for (let i = 0; i < 7; i++) matrix[size - 1 - i][8] = (bits >> (14 - i)) & 1 ? 3 : 4;
    for (let i = 0; i < 8; i++) matrix[8][size - 8 + i] = (bits >> (7 - i)) & 1 ? 3 : 4;
  }

  function scorePenalty(matrix) {
    const size = matrix.length;
    const isDark = (r, c) => matrix[r][c] === 1 || matrix[r][c] === 3;
    let penalty = 0;

    // Rule 1: consecutive same-color modules in row/col
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (isDark(r, c) === isDark(r, c - 1)) { run++; }
        else { if (run >= 5) penalty += run - 2; run = 1; }
      }
      if (run >= 5) penalty += run - 2;
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (isDark(r, c) === isDark(r - 1, c)) { run++; }
        else { if (run >= 5) penalty += run - 2; run = 1; }
      }
      if (run >= 5) penalty += run - 2;
    }

    // Rule 4: proportion of dark modules
    let dark = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (isDark(r, c)) dark++;
    const pct = dark / (size * size) * 100;
    penalty += Math.abs(Math.round(pct / 5) * 5 - 50) * 2;

    return penalty;
  }

  function generate(text) {
    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length);
    if (version < 0) throw new Error('Text too long for QR code');

    const dataCW = encodeData(bytes, version);
    const codewords = interleaveBlocks(dataCW, version);
    const baseMatrix = createMatrix(version);
    placeData(baseMatrix, codewords);

    // Try all masks, pick best
    let bestMask = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const masked = applyMask(baseMatrix, m);
      writeFormatInfo(masked, m);
      const score = scorePenalty(masked);
      if (score < bestScore) { bestScore = score; bestMask = m; }
    }

    const final = applyMask(baseMatrix, bestMask);
    writeFormatInfo(final, bestMask);
    return final;
  }

  function toSVG(text, opts = {}) {
    const { size = 256, margin = 4, dark = '#000', light = '#fff' } = opts;
    const matrix = generate(text);
    const modCount = matrix.length;
    const totalMods = modCount + margin * 2;
    const scale = size / totalMods;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalMods} ${totalMods}" width="${size}" height="${size}" shape-rendering="crispEdges">`;
    svg += `<rect width="${totalMods}" height="${totalMods}" fill="${light}"/>`;

    for (let r = 0; r < modCount; r++) {
      for (let c = 0; c < modCount; c++) {
        const v = matrix[r][c];
        if (v === 1 || v === 3) {
          svg += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1" fill="${dark}"/>`;
        }
      }
    }

    svg += '</svg>';
    return svg;
  }

  return { generate, toSVG };
})();

// Export for use in app.js
if (typeof window !== 'undefined') window.QR = QR;

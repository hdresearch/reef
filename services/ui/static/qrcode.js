// =============================================================================
// QR Code generator — pure JS, zero dependencies, SVG output
// Supports alphanumeric/byte mode, error correction level L
// Sufficient for URLs up to ~200 characters
// =============================================================================

/* eslint-disable */
var QRCode = (function () {
  // GF(256) math
  var EXP = new Uint8Array(256), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    }
    EXP[255] = EXP[0];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  function polyMul(a, b) {
    var result = new Uint8Array(a.length + b.length - 1);
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        result[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return result;
  }

  function generatorPoly(n) {
    var g = new Uint8Array([1]);
    for (var i = 0; i < n; i++) {
      g = polyMul(g, new Uint8Array([1, EXP[i]]));
    }
    return g;
  }

  function ecBytes(data, ecCount) {
    var gen = generatorPoly(ecCount);
    var msg = new Uint8Array(data.length + ecCount);
    msg.set(data);
    for (var i = 0; i < data.length; i++) {
      var coef = msg[i];
      if (coef !== 0) {
        for (var j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  // Version info table: [version, totalCodewords, ecCodewordsPerBlock, numBlocks]
  // Error correction level L only
  var VERSION_TABLE = [
    [1, 26, 7, 1], [2, 44, 10, 1], [3, 70, 15, 1], [4, 100, 20, 1],
    [5, 134, 26, 1], [6, 172, 18, 2], [7, 196, 20, 2], [8, 242, 24, 2],
    [9, 292, 30, 2], [10, 346, 18, 4], [11, 404, 20, 4], [12, 466, 24, 4],
    [13, 532, 26, 4], [14, 581, 30, 4], [15, 655, 22, 6], [16, 733, 24, 6],
    [17, 815, 28, 6], [18, 901, 30, 6], [19, 991, 26, 8], [20, 1085, 28, 8],
  ];

  function getVersion(dataLen) {
    for (var i = 0; i < VERSION_TABLE.length; i++) {
      var v = VERSION_TABLE[i];
      var dataCw = v[1] - v[2] * v[3];
      if (dataCw >= dataLen) return { version: v[0], totalCw: v[1], ecCw: v[2], blocks: v[3], dataCw: dataCw };
    }
    return null;
  }

  function encodeData(text) {
    // Byte mode encoding
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) bytes.push(c);
      else if (c < 2048) { bytes.push(0xc0 | (c >> 6)); bytes.push(0x80 | (c & 0x3f)); }
      else { bytes.push(0xe0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3f)); bytes.push(0x80 | (c & 0x3f)); }
    }

    var vInfo = getVersion(bytes.length + 3); // mode + length + data + terminator overhead
    if (!vInfo) return null;

    // Build bit stream
    var bits = [];
    function addBits(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }

    addBits(4, 4); // byte mode indicator
    var lenBits = vInfo.version <= 9 ? 8 : 16;
    addBits(bytes.length, lenBits);
    for (var i = 0; i < bytes.length; i++) addBits(bytes[i], 8);
    addBits(0, Math.min(4, vInfo.dataCw * 8 - bits.length)); // terminator

    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Pad to fill data capacity
    var padBytes = [0xec, 0x11];
    var pi = 0;
    while (bits.length < vInfo.dataCw * 8) {
      addBits(padBytes[pi % 2], 8);
      pi++;
    }

    // Convert to bytes
    var data = new Uint8Array(vInfo.dataCw);
    for (var i = 0; i < data.length; i++) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] || 0);
      data[i] = b;
    }

    return { data: data, vInfo: vInfo };
  }

  function interleave(data, vInfo) {
    var blocks = vInfo.blocks;
    var ecCw = vInfo.ecCw;
    var baseSize = Math.floor(vInfo.dataCw / blocks);
    var extraBlocks = vInfo.dataCw % blocks;

    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;

    for (var i = 0; i < blocks; i++) {
      var size = baseSize + (i >= blocks - extraBlocks ? 1 : 0);
      var block = data.slice(offset, offset + size);
      dataBlocks.push(block);
      ecBlocks.push(ecBytes(block, ecCw));
      offset += size;
    }

    var result = [];
    var maxDataLen = baseSize + (extraBlocks > 0 ? 1 : 0);
    for (var i = 0; i < maxDataLen; i++) {
      for (var j = 0; j < blocks; j++) {
        if (i < dataBlocks[j].length) result.push(dataBlocks[j][i]);
      }
    }
    for (var i = 0; i < ecCw; i++) {
      for (var j = 0; j < blocks; j++) {
        result.push(ecBlocks[j][i]);
      }
    }
    return result;
  }

  // Matrix operations
  function createMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) {
      m[i] = new Int8Array(size); // 0=unset, 1=black, -1=white(reserved)
    }
    return m;
  }

  function setModule(matrix, row, col, isBlack) {
    if (row >= 0 && row < matrix.length && col >= 0 && col < matrix.length) {
      matrix[row][col] = isBlack ? 1 : -1;
    }
  }

  function addFinderPattern(matrix, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                      (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                      (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(matrix, row + r, col + c, isBlack ? 1 : 0);
      }
    }
  }

  function addAlignmentPattern(matrix, row, col) {
    for (var r = -2; r <= 2; r++) {
      for (var c = -2; c <= 2; c++) {
        var isBlack = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        setModule(matrix, row + r, col + c, isBlack);
      }
    }
  }

  var ALIGNMENT_POSITIONS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  ];

  function addTimingPatterns(matrix) {
    var size = matrix.length;
    for (var i = 8; i < size - 8; i++) {
      var isBlack = i % 2 === 0;
      if (matrix[6][i] === 0) setModule(matrix, 6, i, isBlack);
      if (matrix[i][6] === 0) setModule(matrix, i, 6, isBlack);
    }
  }

  function addFormatInfo(matrix, mask) {
    var size = matrix.length;
    // ECL L = 01, mask pattern
    var data = (1 << 3) | mask; // 01 + mask
    var bits = data;
    for (var i = 0; i < 10; i++) {
      if (bits & (1 << (14 - i))) bits ^= 0x537 << (4 - i);
    }
    // Recalculate properly
    var formatInfo = data << 10;
    var gen = 0x537;
    for (var i = 14; i >= 10; i--) {
      if (formatInfo & (1 << i)) formatInfo ^= gen << (i - 10);
    }
    formatInfo = ((data << 10) | formatInfo) ^ 0x5412;

    // Place around finders
    var formatBits = [];
    for (var i = 14; i >= 0; i--) formatBits.push((formatInfo >> i) & 1);

    // Top-left finder (horizontal)
    var pos = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    for (var i = 0; i < 15; i++) {
      setModule(matrix, pos[i][0], pos[i][1], formatBits[i]);
    }

    // Bottom-left and top-right
    var pos2 = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
    ];
    for (var i = 0; i < 15; i++) {
      setModule(matrix, pos2[i][0], pos2[i][1], formatBits[i]);
    }

    // Dark module
    setModule(matrix, size - 8, 8, 1);
  }

  function placeData(matrix, codewords) {
    var size = matrix.length;
    var bitIdx = 0;
    var totalBits = codewords.length * 8;

    var col = size - 1;
    var goingUp = true;

    while (col >= 0) {
      if (col === 6) col--; // skip timing column

      var rows = goingUp ? [] : [];
      for (var r = 0; r < size; r++) {
        rows.push(goingUp ? size - 1 - r : r);
      }

      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        for (var dx = 0; dx <= 1; dx++) {
          var c = col - dx;
          if (c < 0 || matrix[row][c] !== 0) continue;
          if (bitIdx < totalBits) {
            var byteIdx = Math.floor(bitIdx / 8);
            var bitPos = 7 - (bitIdx % 8);
            matrix[row][c] = (codewords[byteIdx] >> bitPos) & 1 ? 1 : -1;
            bitIdx++;
          } else {
            matrix[row][c] = -1;
          }
        }
      }

      goingUp = !goingUp;
      col -= 2;
    }
  }

  function applyMask(matrix, mask) {
    var size = matrix.length;
    var result = [];
    for (var r = 0; r < size; r++) {
      result[r] = new Int8Array(matrix[r]);
    }
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (result[r][c] === 0) continue; // reserved/empty
        var shouldFlip = false;
        switch (mask) {
          case 0: shouldFlip = (r + c) % 2 === 0; break;
          case 1: shouldFlip = r % 2 === 0; break;
          case 2: shouldFlip = c % 3 === 0; break;
          case 3: shouldFlip = (r + c) % 3 === 0; break;
          case 4: shouldFlip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: shouldFlip = (r * c) % 2 + (r * c) % 3 === 0; break;
          case 6: shouldFlip = ((r * c) % 2 + (r * c) % 3) % 2 === 0; break;
          case 7: shouldFlip = ((r + c) % 2 + (r * c) % 3) % 2 === 0; break;
        }
        // Only flip data modules (not finder/alignment/timing patterns)
        if (shouldFlip) {
          result[r][c] = result[r][c] === 1 ? -1 : 1;
        }
      }
    }
    return result;
  }

  function penaltyScore(matrix) {
    var size = matrix.length;
    var score = 0;

    // Rule 1: consecutive same-color modules in row/col
    for (var r = 0; r < size; r++) {
      var count = 1;
      for (var c = 1; c < size; c++) {
        if ((matrix[r][c] > 0) === (matrix[r][c - 1] > 0)) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score += 1;
        } else { count = 1; }
      }
    }
    for (var c = 0; c < size; c++) {
      var count = 1;
      for (var r = 1; r < size; r++) {
        if ((matrix[r][c] > 0) === (matrix[r - 1][c] > 0)) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score += 1;
        } else { count = 1; }
      }
    }

    // Rule 4: proportion of dark modules
    var dark = 0;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (matrix[r][c] > 0) dark++;
      }
    }
    var pct = Math.floor(dark * 100 / (size * size));
    var prev5 = Math.abs(Math.floor(pct / 5) * 5 - 50) / 5;
    var next5 = Math.abs(Math.ceil(pct / 5) * 5 - 50) / 5;
    score += Math.min(prev5, next5) * 10;

    return score;
  }

  function generate(text) {
    var encoded = encodeData(text);
    if (!encoded) return null;

    var vInfo = encoded.vInfo;
    var size = vInfo.version * 4 + 17;
    var codewords = interleave(encoded.data, vInfo);

    // Build base matrix with patterns
    var base = createMatrix(size);

    // Finder patterns
    addFinderPattern(base, 0, 0);
    addFinderPattern(base, 0, size - 7);
    addFinderPattern(base, size - 7, 0);

    // Alignment patterns
    if (vInfo.version >= 2) {
      var positions = ALIGNMENT_POSITIONS[vInfo.version];
      for (var i = 0; i < positions.length; i++) {
        for (var j = 0; j < positions.length; j++) {
          // Skip if overlapping finder patterns
          if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) continue;
          addAlignmentPattern(base, positions[i], positions[j]);
        }
      }
    }

    addTimingPatterns(base);

    // Reserve format info areas
    for (var i = 0; i < 8; i++) {
      if (base[8][i] === 0) setModule(base, 8, i, 0);
      if (base[i][8] === 0) setModule(base, i, 8, 0);
      if (base[8][size - 1 - i] === 0) setModule(base, 8, size - 1 - i, 0);
      if (base[size - 1 - i][8] === 0) setModule(base, size - 1 - i, 8, 0);
    }
    if (base[8][8] === 0) setModule(base, 8, 8, 0);

    // Place data
    placeData(base, codewords);

    // Try all masks, pick best
    var bestMask = 0;
    var bestScore = Infinity;
    var bestMatrix = null;

    for (var mask = 0; mask < 8; mask++) {
      var masked = applyMask(base, mask);
      // Re-add format info for this mask
      addFormatInfo(masked, mask);
      var s = penaltyScore(masked);
      if (s < bestScore) {
        bestScore = s;
        bestMask = mask;
        bestMatrix = masked;
      }
    }

    return { matrix: bestMatrix, size: size, version: vInfo.version };
  }

  function toSVG(text, options) {
    options = options || {};
    var qr = generate(text);
    if (!qr) return null;

    var scale = options.scale || 4;
    var margin = options.margin !== undefined ? options.margin : 4;
    var totalSize = (qr.size + margin * 2) * scale;

    var paths = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.matrix[r][c] > 0) {
          var x = (c + margin) * scale;
          var y = (r + margin) * scale;
          paths.push('M' + x + ',' + y + 'h' + scale + 'v' + scale + 'h-' + scale + 'z');
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalSize + ' ' + totalSize +
           '" width="' + totalSize + '" height="' + totalSize + '">' +
           '<rect width="100%" height="100%" fill="#fff"/>' +
           '<path d="' + paths.join('') + '" fill="#000"/></svg>';
  }

  return { generate: generate, toSVG: toSVG };
})();

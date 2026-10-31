/**
 * QR code as SVG, written here so the register needs no third-party code.
 *
 * Byte mode, error correction level M, versions 1–10 (up to 213 bytes; an
 * IBAN is 26). Follows the QR standard (ISO/IEC 18004): Reed–Solomon error
 * correction over GF(256), block interleaving, and the mask with the lowest
 * penalty score.
 */

/** Level M, indexed by version: error correction codewords per block, and number of blocks. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits for level M. */
const LEVEL_BITS = 0;
const QUIET_ZONE = 4;

const bit = (value, i) => ((value >>> i) & 1) !== 0;

/** Data and error correction modules of a version: everything but the function patterns. */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// --- Reed–Solomon over GF(2^8), polynomial 0x11D ---

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
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
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
  }
  return result;
}

/** Splits the data into blocks, appends each block's error correction, and interleaves them. */
function withErrorCorrection(data, ver) {
  const numBlocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < numShort) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // Short blocks carry a placeholder in the last data position.
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

// --- Data ---

/** Byte-mode bit stream, padded to the version's capacity. */
function encode(bytes) {
  let ver = 1;
  const countBits = (v) => (v <= 9 ? 8 : 16);
  while (ver <= 10 && 4 + countBits(ver) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
  if (ver > 10) throw new Error("QR: text too long");
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(ver));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  return { ver, codewords };
}

// --- Matrix ---

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function build(ver, codewords) {
  const size = ver * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, value) => {
    dark[y][x] = value;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(ver, size);
  const last = align.length - 1;
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  // Reserve the format areas; drawFormat fills them per mask.
  drawFormat(set, size, 0);

  const data = withErrorCorrection(codewords, ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < data.length * 8) {
          dark[y][x] = bit(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
  return { size, dark, fixed, set };
}

function drawFormat(set, size, mask) {
  const data = (LEVEL_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask({ size, dark, fixed }, mask) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
}

/** The standard's penalty: long runs, 2×2 blocks, finder look-alikes, and dark/light imbalance. */
function penalty({ size, dark }) {
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let k = 1; k <= size; k++) {
      if (k < size && line[k] === line[k - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const s = `0000${line.map((d) => (d ? 1 : 0)).join("")}0000`;
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let at = s.indexOf(pattern); at !== -1; at = s.indexOf(pattern, at + 1)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The QR code of `text` as an SVG string (black on white, with the standard quiet zone). */
export function qrSvg(text) {
  const { ver, codewords } = encode(new TextEncoder().encode(text));
  const qr = build(ver, codewords);
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(qr, mask);
    drawFormat(qr.set, qr.size, mask);
    const score = penalty(qr);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(qr, mask);
  }
  applyMask(qr, best);
  drawFormat(qr.set, qr.size, best);

  const side = qr.size + QUIET_ZONE * 2;
  let path = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.dark[y][x]) path += `M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`;
  }
  return `<svg viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img"><rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

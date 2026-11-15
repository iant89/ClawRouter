/**
 * A small QR code encoder (ISO/IEC 18004) for the authenticator-app setup link.
 * It runs in the browser, so the secret never leaves the page.
 *
 * Byte mode, error-correction level M, versions 1–20 (up to 666 bytes: far more
 * than an otpauth:// link needs). The mask with the lowest penalty is chosen, as
 * the standard describes. Tests decode every version with zxing's reader.
 */

/** Error-correction level M, per version 1–20: EC codewords per block, then [blocks, data codewords] groups. */
const ECC_M: ReadonlyArray<readonly [number, ...(readonly [number, number])[]]> = [
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
  [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]], [22, [8, 37], [1, 38]], [24, [4, 40], [5, 41]], [24, [5, 41], [5, 42]],
  [28, [7, 45], [3, 46]], [28, [10, 46], [1, 47]], [26, [9, 43], [4, 44]], [26, [3, 44], [11, 45]], [26, [3, 41], [13, 42]],
];
export const QR_MAX_VERSION = ECC_M.length;
/** Format bits for level M are 00. */
const ECC_LEVEL_M_BITS = 0;

export interface QrMatrix {
  version: number;
  /** Modules per side (17 + 4 × version). */
  size: number;
  /** Row-major; true is a dark module. */
  modules: boolean[][];
  mask: number;
}

const dataCodewords = (version: number) => {
  const [, ...groups] = ECC_M[version - 1]!;
  return groups.reduce((n, [blocks, words]) => n + blocks * words, 0);
};
/** Bits for the byte count: 8 up to version 9, then 16. */
const countBits = (version: number) => (version <= 9 ? 8 : 16);

// --- Reed–Solomon over GF(256), polynomial 0x11D ---------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((c, j) => {
      next[j] = next[j]! ^ c;
      next[j + 1] = next[j + 1]! ^ mul(c, EXP[i]!);
    });
    poly = next;
  }
  return poly;
}

function remainder(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const out = [...data, ...new Array<number>(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = out[i]!;
    if (factor) for (let j = 0; j < gen.length; j++) out[i + j] = out[i + j]! ^ mul(gen[j]!, factor);
  }
  return out.slice(data.length);
}

// --- Codewords -----------------------------------------------------------------
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  // Split into blocks, add error correction to each, then interleave.
  const [ecLength, ...groups] = ECC_M[version - 1]!;
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, words] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(offset, offset + words)); offset += words; }
  const ecBlocks = blocks.map((b) => remainder(b, ecLength));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLength; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

// --- Function patterns ---------------------------------------------------------
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

/** BCH remainder of `value` (shifted by the generator's degree). */
function bch(value: number, generatorPoly: number): number {
  const degree = Math.floor(Math.log2(generatorPoly));
  let r = value << degree;
  while (Math.floor(Math.log2(r || 1)) >= degree && r) r ^= generatorPoly << (Math.floor(Math.log2(r)) - degree);
  return (value << degree) | r;
}

class Grid {
  readonly modules: boolean[][];
  readonly reserved: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    grid.set(6, i, i % 2 === 0);
    grid.set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      grid.set(x, y, d !== 2 && d !== 4);
    }
  }
  // Alignment patterns, except where they would overlap the finders.
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  pos.forEach((cy, i) => pos.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  // Reserve the format areas (written after masking) and the dark module.
  drawFormat(grid, 0);
  // Version information, versions 7 and up.
  if (version >= 7) {
    const bits = bch(version, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      grid.set(a, b, dark);
      grid.set(b, a, dark);
    }
  }
}

function drawFormat(grid: Grid, mask: number) {
  const { size } = grid;
  const bits = bch((ECC_LEVEL_M_BITS << 3) | mask, 0x537) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) grid.set(8, i, bit(i));
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.set(14 - i, 8, bit(i));
  // Split between the other two finders.
  for (let i = 0; i < 8; i++) grid.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.set(8, size - 15 + i, bit(i));
  grid.set(8, size - 8, true); // the dark module
}

function drawCodewords(grid: Grid, data: number[]) {
  const { size } = grid;
  let i = 0;
  // Two-module columns from the right, zigzagging up and down, skipping the timing column.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!grid.reserved[y]![x] && i < data.length * 8) {
          grid.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number) {
  const test = MASKS[mask]!;
  for (let y = 0; y < grid.size; y++) for (let x = 0; x < grid.size; x++) {
    if (!grid.reserved[y]![x] && test(x, y)) grid.modules[y]![x] = !grid.modules[y]![x];
  }
}

/** The standard's four penalty rules; the mask with the lowest total is used. */
export function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lines: boolean[][] = [...m, ...m[0]!.map((_, x) => m.map((row) => row[x]!))];
  for (const line of lines) {
    // Rule 1: runs of five or more.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    // Rule 3: finder-like 1011101 with four light modules on either side.
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (const p of ['10111010000', '00001011101']) for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + 1)) score += 40;
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y]![x];
    if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
  }
  // Rule 4: balance of dark and light.
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encodes `text` (UTF-8) as a QR code at level M in the smallest version that fits.
 * `mask` forces a mask pattern (tests); by default the lowest-penalty one is used.
 */
export function encodeQr(text: string, options: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(1, options.minVersion ?? 1);
  while (version <= QR_MAX_VERSION && 4 + countBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > QR_MAX_VERSION) throw new Error(`Too long for a QR code here (${bytes.length} bytes).`);

  const data = codewords(bytes, version);
  const build = (mask: number) => {
    const grid = new Grid(17 + 4 * version);
    drawFunctionPatterns(grid, version);
    drawCodewords(grid, data);
    applyMask(grid, mask);
    drawFormat(grid, mask);
    return grid;
  };
  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (const mask of options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask]) {
    const grid = build(mask);
    const score = penalty(grid.modules);
    if (!best || score < best.score) best = { grid, mask, score };
  }
  return { version, size: best!.grid.size, modules: best!.grid.modules, mask: best!.mask };
}

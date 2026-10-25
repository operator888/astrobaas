/**
 * A small QR Code generator (ISO/IEC 18004), byte mode, error-correction level
 * M, versions 1–13. Written for one job — the GiroCode (EPC069-12) on an
 * invoice — so it carries no dependency and supports exactly what that needs:
 * up to 331 bytes of UTF-8, which is also the EPC limit.
 *
 * Structure follows the reference algorithm (Nayuki's public-domain
 * description): pick the smallest version that fits, split the data into
 * blocks, append Reed–Solomon codewords and interleave, draw the function
 * patterns, place the bits in the zig-zag order, then choose the mask with the
 * lowest penalty. Verified against an independent decoder in the test suite.
 */

const MAX_VERSION = 13;

/** Error-correction codewords per block, level M, indexed by version. */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22];
/** Number of error-correction blocks, level M, indexed by version. */
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9];

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];
}

/** The most bytes a version-`ver` symbol can carry in byte mode at level M. */
export function qrCapacityBytes(ver: number): number {
  const countBits = ver <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(ver) * 8 - 4 - countBits) / 8);
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
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

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function bit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

/** Encode UTF-8 bytes; returns the module matrix (true = dark), row-major. */
export function qrEncode(data: Uint8Array): boolean[][] {
  let ver = 1;
  while (ver <= MAX_VERSION && data.length > qrCapacityBytes(ver)) ver++;
  if (ver > MAX_VERSION) throw new Error(`QR payload too long (${data.length} bytes).`);

  // 1. Bit stream: mode (byte), length, data, terminator, padding.
  const bits: number[] = [];
  const put = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(data.length, ver <= 9 ? 8 : 16);
  for (const b of data) put(b, 8);
  const capBits = dataCodewords(ver) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }

  // 2. Split into blocks, add Reed–Solomon, interleave.
  const numBlocks = BLOCKS_M[ver];
  const eccLen = ECC_PER_BLOCK_M[ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = codewords.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // placeholder so short and long blocks interleave by index
    blocks.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // The placeholder in short blocks sits at index shortLen - eccLen.
      if (i !== shortLen - eccLen || j >= numShort) all.push(block[i]);
    });
  }

  // 3. Function patterns.
  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFn[y][x] = true; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx; const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align: number[] = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    align.push(6);
    for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
  }
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask: number) => {
    const d = (0 << 3) | mask; // level M = 0b00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(fmt, i));
    setFn(8, 7, bit(fmt, 6)); setFn(8, 8, bit(fmt, 7)); setFn(7, 8, bit(fmt, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(fmt, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(fmt, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(fmt, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserve the area; redrawn with the real mask below
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = bit(v, i);
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      setFn(a, b, dark); setFn(b, a, dark);
    }
  }

  // 4. Codewords in the zig-zag order.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && k < all.length * 8) {
          modules[y][x] = bit(all[k >>> 3], 7 - (k & 7));
          k++;
        }
      }
    }
  }

  // 5. Mask with the lowest penalty.
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!isFn[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
  };

  const penalty = (): number => {
    let result = 0;
    const addHistory = (run: number, h: number[]) => { if (h[0] === 0) run += size; h.pop(); h.unshift(run); };
    const countPatterns = (h: number[]): number => {
      const n = h[1];
      const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    };
    const scan = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < size; a++) {
        let runColor = false; let runLen = 0; const h = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          if (get(a, b) === runColor) {
            runLen++;
            if (runLen === 5) result += 3; else if (runLen > 5) result++;
          } else {
            addHistory(runLen, h);
            if (!runColor) result += countPatterns(h) * 40;
            runColor = get(a, b); runLen = 1;
          }
        }
        if (runColor) { addHistory(runLen, h); runLen = 0; }
        runLen += size;
        addHistory(runLen, h);
        result += countPatterns(h) * 40;
      }
    };
    scan((y, x) => modules[y][x]);
    scan((x, y) => modules[y][x]);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  };

  let best = 0; let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestScore) { bestScore = p; best = m; }
    applyMask(m); // undo
  }
  applyMask(best); drawFormat(best);
  return modules;
}

/**
 * The payload of a GiroCode / EPC QR ("SEPA credit transfer", EPC069-12 v2,
 * UTF-8): what a banking app reads to prefill a transfer. Returns null when
 * the data cannot form a valid one (no IBAN, amount outside 0.01–999 999 999.99).
 */
export function epcPayload(p: { name: string; iban: string; bic?: string; amount_cents: number; reference: string }): string | null {
  const iban = p.iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return null;
  if (!Number.isInteger(p.amount_cents) || p.amount_cents < 1 || p.amount_cents > 99_999_999_999) return null;
  const clean = (v: string, max: number) => v.replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  const amount = `EUR${Math.floor(p.amount_cents / 100)}.${String(p.amount_cents % 100).padStart(2, '0')}`;
  const payload = [
    'BCD', '002', '1', 'SCT',
    clean((p.bic ?? '').replace(/\s+/g, '').toUpperCase(), 11),
    clean(p.name, 70), iban, amount, '', '',
    clean(p.reference, 140),
  ].join('\n');
  return new TextEncoder().encode(payload).length <= 331 ? payload : null;
}

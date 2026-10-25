import { describe, expect, it } from 'vitest';
import { colorCorrect, dilate, distanceTo, editMask, featherComposite, fraction, keepOnly, maskImage, maskedBlur, masksFromState, pushPull, untouched } from '../src/core/composite';
import { mulberry32 } from '../src/core/planner';

const W = 16, H = 8;
const img = (fill: (x: number, y: number) => number[]) => {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.set(fill(x, y), 4 * (y * W + x));
  return a;
};

describe('masks', () => {
  it('reads geometry and known flags from the state mask image', () => {
    const m = masksFromState(img((x) => [x < 8 ? 255 : 0, x < 4 ? 255 : 0, 0, 255]));
    expect(Array.from(m.geometry.slice(0, W))).toEqual([...Array(8).fill(1), ...Array(8).fill(0)]);
    expect(Array.from(m.known.slice(0, W))).toEqual([...Array(4).fill(1), ...Array(12).fill(0)]);
  });

  it('dilates by a square kernel', () => {
    const m = new Uint8Array(W * H);
    m[3 * W + 5] = 1;
    const d = dilate(m, W, H, 2);
    expect(fraction(d)).toBeCloseTo(25 / (W * H));
    expect(d[1 * W + 3]).toBe(1);
    expect(d[0 * W + 5]).toBe(0);
  });

  it('grows the edit mask into known pixels but never past geometry', () => {
    const m = masksFromState(img((x) => [x < 12 ? 255 : 0, x < 6 ? 255 : 0, 0, 255]));
    const e = editMask(m, W, H, 2);
    expect(e[4]).toBe(1);   // known, but within 2 px of unknown
    expect(e[3]).toBe(0);
    expect(e[13]).toBe(0);  // sky
  });
});

describe('distanceTo', () => {
  it('matches Euclidean distance along axes', () => {
    const seed = new Uint8Array(W * H);
    seed[0] = 1;
    const d = distanceTo(seed, W, H);
    expect(d[5]).toBeCloseTo(5);
    expect(d[3 * W]).toBeCloseTo(3);
    expect(d[2 * W + 2]).toBeCloseTo(2 * Math.SQRT2);
  });
});

describe('featherComposite', () => {
  it('keeps known pixels away from the seam and fades the new image in next to it', () => {
    const state = img(() => [100, 100, 100, 255]);
    const gen = img(() => [200, 200, 200, 255]);
    const m = masksFromState(img((x) => [255, x < 10 ? 255 : 0, 0, 255]));
    const out = featherComposite(state, gen, m, W, H, 4);
    const at = (x: number) => out[4 * (2 * W + x)];
    expect(at(0)).toBe(100);           // deep in known area: untouched
    expect(at(12)).toBe(200);          // unknown: generated
    expect(at(9)).toBeGreaterThan(100); // known, next to the seam: blended
    expect(at(9)).toBeLessThan(200);
    expect(at(8)).toBeLessThan(at(9)); // weight rises toward the seam
  });

  it('inverts masks for black-means-edit APIs', () => {
    const e = new Uint8Array([1, 0]);
    expect(Array.from(maskImage(e).slice(0, 8))).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(Array.from(maskImage(e, true).slice(0, 8))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('seam colour correction', () => {
  const BW = 64, BH = 32;
  const big = (fill: (x: number, y: number) => number[]) => {
    const a = new Uint8ClampedArray(BW * BH * 4);
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) a.set(fill(x, y), 4 * (y * BW + x));
    return a;
  };

  it('push-pull fills holes smoothly from known values', () => {
    const v = new Float32Array(BW * BH * 3);
    const w = new Float32Array(BW * BH);
    for (let y = 0; y < BH; y++) { v[3 * (y * BW)] = 10; w[y * BW] = 1; v[3 * (y * BW + BW - 1)] = 30; w[y * BW + BW - 1] = 1; }
    const f = pushPull(v, w, BW, BH);
    const at = (x: number) => f[3 * (16 * BW + x)];
    expect(at(0)).toBeCloseTo(10);
    expect(at(BW - 1)).toBeCloseTo(30);
    expect(at(32)).toBeGreaterThan(12);
    expect(at(32)).toBeLessThan(28);
  });

  it('masked blur ignores pixels outside the mask', () => {
    const src = big((x) => (x < 32 ? [100, 100, 100, 255] : [250, 0, 0, 255]));
    const mask = new Uint8Array(BW * BH);
    for (let y = 0; y < BH; y++) for (let x = 0; x < 32; x++) mask[y * BW + x] = 1;
    const b = maskedBlur(src, mask, BW, BH, 5);
    expect(b[3 * (10 * BW + 31)]).toBeCloseTo(100);
  });

  it('removes a colour step at the boundary and fades out away from it', () => {
    const state = big(() => [100, 100, 100, 255]);
    const gen = big(() => [160, 160, 160, 255]);
    const m = masksFromState(big((x) => [255, x < 20 ? 255 : 0, 0, 255]));
    const g2 = colorCorrect(state, gen, m, BW, BH, { band: 4, blur: 3, falloff: 20 });
    const at = (x: number) => g2[4 * (16 * BW + x)];
    expect(Math.abs(at(21) - 100)).toBeLessThan(10);   // just past the seam: matches the known side
    expect(at(60)).toBeGreaterThan(at(30));             // correction fades with distance
    const comp = featherComposite(state, g2, m, BW, BH, 4);
    const c = (x: number) => comp[4 * (16 * BW + x)];
    expect(Math.abs(c(20) - c(19))).toBeLessThan(6);    // no visible step at the seam
  });
});

describe('keepOnly', () => {
  it('makes geometry outside the keep mask transparent and leaves sky alone', () => {
    const comp = img(() => [90, 80, 70, 255]);
    const keep = new Uint8Array(W * H).map((_, i) => ((i % W) < 4 ? 1 : 0));
    const geometry = new Uint8Array(W * H).map((_, i) => ((i % W) < 12 ? 1 : 0));
    const out = keepOnly(comp, keep, geometry);
    expect(Array.from(out.slice(0, 4))).toEqual([90, 80, 70, 255]);              // kept
    expect(Array.from(out.slice(4 * 6, 4 * 7))).toEqual([0, 0, 0, 0]);           // geometry, not kept
    expect(Array.from(out.slice(4 * 14, 4 * 15))).toEqual([90, 80, 70, 255]);    // sky
  });
});

describe('colorCorrect', () => {
  it('leaves the new image alone when the model kept the known texture, even next to another material', () => {
    // known wall on the left (light), new roof on the right (dark): no drift on the known side, so no shift
    const state = img((x) => (x < 8 ? [200, 180, 150, 255] : [128, 128, 128, 255]));
    const gen = img((x) => (x < 8 ? [200, 180, 150, 255] : [150, 70, 50, 255]));
    const m = masksFromState(img((x) => [255, x < 8 ? 255 : 0, 0, 255]));
    const out = colorCorrect(state, gen, m, W, H, { band: 3, blur: 2, falloff: 20 });
    expect(out[4 * (3 * W + 12)]).toBe(150);
    expect(out[4 * (3 * W + 12) + 1]).toBe(70);
  });
});

describe('untouched', () => {
  it('flags the parts of the area the model handed back unchanged', () => {
    const state = img(() => [128, 128, 128, 255]);
    const gen = img((x) => (x < 8 ? [129, 127, 128, 255] : [170, 120, 80, 255]));   // left half: still clay
    const area = new Uint8Array(W * H).fill(1);
    const u = untouched(state, gen, area, W, H, 6, 1);
    expect(u[3 * W + 2]).toBe(1);
    expect(u[3 * W + 13]).toBe(0);
    expect(untouched(state, gen, new Uint8Array(W * H), W, H)[3 * W + 2]).toBe(0);   // outside the area
  });
});

/**
 * CPU image utilities for one view (top-down RGBA8, square or not). Pure functions, unit-tested.
 */

export interface ViewMasks {
  /** 1 where the pixel shows level geometry (0 = sky/background). */
  geometry: Uint8Array;
  /** 1 where the pixel shows texture that is already good enough to keep. */
  known: Uint8Array;
}

export function masksFromState(mask: Uint8ClampedArray): ViewMasks {
  const n = mask.length / 4;
  const geometry = new Uint8Array(n);
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    geometry[i] = mask[4 * i] > 127 ? 1 : 0;
    known[i] = mask[4 * i + 1] > 127 ? 1 : 0;
  }
  return { geometry, known };
}

/** 1 where the pixel shows geometry with any paint at all, however poor (blue channel of the state mask). */
export function paintedFromState(mask: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(mask.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = mask[4 * i + 2] > 127 ? 1 : 0;
  return out;
}

/**
 * Pixels of `area` the model handed back as it got them: still the gray clay, give or take compression noise
 * (mean of the largest channel difference over a (2r+1)² box below `tol`). Projected, they would pass for paint.
 */
export function untouched(state: Uint8ClampedArray, gen: Uint8ClampedArray, area: Uint8Array, w: number, h: number,
  tol = 6, r = 3): Uint8Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) {
    const p = 4 * i;
    d[i] = Math.max(Math.abs(gen[p] - state[p]), Math.abs(gen[p + 1] - state[p + 1]), Math.abs(gen[p + 2] - state[p + 2]));
  }
  const all = new Uint8Array(w * h).fill(1);
  const rgb = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i++) rgb[4 * i] = Math.min(255, d[i]);
  const m = maskedBlur(rgb, all, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = area[i] && m[3 * i] < tol ? 1 : 0;
  return out;
}

/** Square-kernel binary dilation (Chebyshev radius r), separable. */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) run = x; tmp[y * w + x] = x - run <= r ? 1 : 0; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; out[y * w + x] = y - run <= r ? 1 : 0; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/**
 * Chamfer distance (3-4 weights, in pixels) from every pixel to the nearest pixel where `seed` is 1.
 * Seeds have distance 0.
 */
export function distanceTo(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Pixels the model should paint: geometry that isn't known yet, grown `grow` px into the known side. */
export function editMask(m: ViewMasks, w: number, h: number, grow = 3): Uint8Array {
  const unknown = new Uint8Array(m.geometry.length);
  for (let i = 0; i < unknown.length; i++) unknown[i] = m.geometry[i] && !m.known[i] ? 1 : 0;
  const g = dilate(unknown, w, h, grow);
  for (let i = 0; i < g.length; i++) g[i] &= m.geometry[i];
  return g;
}

export function fraction(mask: Uint8Array, of?: Uint8Array): number {
  let n = 0;
  let d = 0;
  for (let i = 0; i < mask.length; i++) {
    if (of && !of[i]) continue;
    d++;
    if (mask[i]) n++;
  }
  return d ? n / d : 0;
}

/**
 * Put the model's output back next to texture we already trust: known pixels are kept exactly, except a
 * `feather`-px band along the boundary where the new image fades in (cuts visible seams; see spike/README.md).
 */
export function featherComposite(state: Uint8ClampedArray, gen: Uint8ClampedArray, m: ViewMasks,
  w: number, h: number, feather = 6): Uint8ClampedArray {
  const out = new Uint8ClampedArray(state.length);
  const unknown = new Uint8Array(m.geometry.length);
  for (let i = 0; i < unknown.length; i++) unknown[i] = m.geometry[i] && !m.known[i] ? 1 : 0;
  const dk = feather > 0 ? distanceTo(unknown, w, h) : null;
  for (let i = 0; i < unknown.length; i++) {
    const p = 4 * i;
    let t: number;                    // weight of the generated image
    if (!m.geometry[i]) t = 1;        // sky: whatever the model painted (never projected)
    else if (unknown[i]) t = 1;
    else if (dk && dk[i] <= feather) t = 1 - dk[i] / (feather + 1);
    else t = 0;
    out[p] = state[p] + (gen[p] - state[p]) * t;
    out[p + 1] = state[p + 1] + (gen[p + 1] - state[p + 1]) * t;
    out[p + 2] = state[p + 2] + (gen[p + 2] - state[p + 2]) * t;
    out[p + 3] = 255;
  }
  return out;
}

/** Separable box blur of the masked pixels only (normalised convolution). Returns RGB float, NaN-free. */
export function maskedBlur(src: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, r: number): Float32Array {
  const num = new Float32Array(w * h * 3);
  const den = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    num[3 * i] = src[4 * i]; num[3 * i + 1] = src[4 * i + 1]; num[3 * i + 2] = src[4 * i + 2];
    den[i] = 1;
  }
  const pass = (a: Float32Array, ch: number, horizontal: boolean) => {
    const out = new Float32Array(a.length);
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const acc = new Float64Array(ch);
    for (let l = 0; l < lines; l++) {
      const idx = (k: number) => (horizontal ? l * w + k : k * w + l);
      acc.fill(0);
      for (let k = 0; k < Math.min(r, n - 1) + 1; k++) for (let c = 0; c < ch; c++) acc[c] += a[ch * idx(k) + c];
      for (let k = 0; k < n; k++) {
        for (let c = 0; c < ch; c++) out[ch * idx(k) + c] = acc[c];
        const add = k + r + 1, sub = k - r;
        if (add < n) for (let c = 0; c < ch; c++) acc[c] += a[ch * idx(add) + c];
        if (sub >= 0) for (let c = 0; c < ch; c++) acc[c] -= a[ch * idx(sub) + c];
      }
    }
    return out;
  };
  const n2 = pass(pass(num, 3, true), 3, false);
  const d2 = pass(pass(den, 1, true), 1, false);
  for (let i = 0; i < w * h; i++) {
    const d = d2[i] > 1e-6 ? d2[i] : 0;
    for (let c = 0; c < 3; c++) n2[3 * i + c] = d ? n2[3 * i + c] / d : 0;
  }
  return n2;
}

/**
 * Push-pull interpolation: values known where `wt` > 0 spread smoothly into everything else (a cheap stand-in for
 * a membrane / Poisson fill). RGB float in, RGB float out.
 */
export function pushPull(val: Float32Array, wt: Float32Array, w: number, h: number): Float32Array {
  type L = { v: Float32Array; a: Float32Array; w: number; h: number };
  const levels: L[] = [{ v: val.slice(), a: wt.slice(), w, h }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const F = levels[levels.length - 1];
    const cw = Math.max(1, Math.ceil(F.w / 2)), ch = Math.max(1, Math.ceil(F.h / 2));
    const v = new Float32Array(cw * ch * 3), a = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let s0 = 0, s1 = 0, s2 = 0, sa = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx, fy = 2 * y + dy;
            if (fx >= F.w || fy >= F.h) continue;
            const j = fy * F.w + fx, wj = F.a[j];
            s0 += F.v[3 * j] * wj; s1 += F.v[3 * j + 1] * wj; s2 += F.v[3 * j + 2] * wj; sa += wj;
          }
        }
        const k = y * cw + x;
        if (sa > 0) { v[3 * k] = s0 / sa; v[3 * k + 1] = s1 / sa; v[3 * k + 2] = s2 / sa; }
        a[k] = Math.min(1, sa);
      }
    }
    levels.push({ v, a, w: cw, h: ch });
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const F = levels[li], C = levels[li + 1];
    for (let y = 0; y < F.h; y++) {
      const cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(cy), y1 = Math.min(C.h - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < F.w; x++) {
        const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), x1 = Math.min(C.w - 1, x0 + 1), fx = cx - x0;
        const j = y * F.w + x, a = F.a[j];
        if (a >= 1) continue;
        for (let c = 0; c < 3; c++) {
          const top = C.v[3 * (y0 * C.w + x0) + c] * (1 - fx) + C.v[3 * (y0 * C.w + x1) + c] * fx;
          const bot = C.v[3 * (y1 * C.w + x0) + c] * (1 - fx) + C.v[3 * (y1 * C.w + x1) + c] * fx;
          F.v[3 * j + c] = a * F.v[3 * j + c] + (1 - a) * (top * (1 - fy) + bot * fy);
        }
        F.a[j] = 1;
      }
    }
  }
  return levels[0].v;
}

/**
 * Shift the model's output so its low frequencies continue the texture we already have: the colour difference
 * along the boundary (blurred, known side) is spread into the new region and fades out over `falloff` px.
 * Removes exposure / white-balance seams between views without touching detail.
 */
export function colorCorrect(state: Uint8ClampedArray, gen: Uint8ClampedArray, m: ViewMasks, w: number, h: number,
  opts: { band?: number; blur?: number; falloff?: number } = {}): Uint8ClampedArray {
  const band = opts.band ?? 6, blur = opts.blur ?? 8, falloff = opts.falloff ?? 120;
  const n = w * h;
  const known = new Uint8Array(n);
  const unknown = new Uint8Array(n);
  let nk = 0, nu = 0;
  for (let i = 0; i < n; i++) {
    if (!m.geometry[i]) continue;
    if (m.known[i]) { known[i] = 1; nk++; } else { unknown[i] = 1; nu++; }
  }
  if (nk < 64 || nu < 64) return gen;
  const toUnknown = distanceTo(unknown, w, h);
  const toKnown = distanceTo(known, w, h);
  // Both blurred over known pixels only: the difference is the model's drift on texture we already have, not the
  // contrast to a neighbouring material (a roof next to a wall) that blurring across the boundary would mix in.
  const S = maskedBlur(state, known, w, h, blur);
  const G = maskedBlur(gen, known, w, h, blur);
  const diff = new Float32Array(n * 3);
  const wt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!known[i] || toUnknown[i] > band) continue;
    for (let c = 0; c < 3; c++) diff[3 * i + c] = S[3 * i + c] - G[3 * i + c];
    wt[i] = 1;
  }
  const field = pushPull(diff, wt, w, h);
  const out = new Uint8ClampedArray(gen.length);
  for (let i = 0; i < n; i++) {
    const p = 4 * i;
    const f = m.geometry[i] ? Math.exp(-toKnown[i] / falloff) : 0;
    out[p] = gen[p] + field[3 * i] * f;
    out[p + 1] = gen[p + 1] + field[3 * i + 1] * f;
    out[p + 2] = gen[p + 2] + field[3 * i + 2] * f;
    out[p + 3] = 255;
  }
  return out;
}

/**
 * Limit what a view projects: geometry outside `keep` becomes transparent (rgb 0, premultiplied), so the atlas
 * skips it and filtering at the edge only averages kept pixels. Sky pixels stay as they are.
 */
export function keepOnly(comp: Uint8ClampedArray, keep: Uint8Array, geometry: Uint8Array): Uint8ClampedArray {
  const out = comp.slice();
  for (let i = 0; i < keep.length; i++) {
    if (keep[i] || !geometry[i]) continue;
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = out[4 * i + 3] = 0;
  }
  return out;
}

/** Mask image for a provider: 255 where the model should edit (or inverted for black-means-edit APIs). */
export function maskImage(edit: Uint8Array, invert = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(edit.length * 4);
  for (let i = 0; i < edit.length; i++) {
    const v = (edit[i] ? 255 : 0) ^ (invert ? 255 : 0);
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = v;
    out[4 * i + 3] = 255;
  }
  return out;
}

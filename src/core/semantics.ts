/**
 * What a view shows, in words, for the prompt: which labelled parts of the level are in the area to paint and
 * roughly where, plus which pixels are roofs. Image models invent less when told what the gray shapes are.
 */
export interface ViewClasses {
  /** Part label index per pixel (-1 = sky), top-down. */
  label: Int16Array;
  /** 1 where the pixel is a roof surface. */
  roof: Uint8Array;
  /** 1 where the pixel is ground you could stand on (not a roof). */
  floor: Uint8Array;
}

export interface ViewDescription {
  /** e.g. "cobblestone ground (bottom), house walls (left), stone fountain (center, small)"; '' without labels */
  parts: string;
  roofShare: number;
  floorShare: number;
}

/** Labels that name roofs; null when the level has none (then roofs are found by slope and height). */
export function roofLabels(labels: string[]): boolean[] | null {
  const r = labels.map((l) => /\broofs?\b/.test(l));
  return r.some(Boolean) ? r : null;
}

/** A roof surface faces up at least this much (normal y): gable ends and fascias labelled as roof are walls. */
export const ROOF_MIN_NY = 0.25;

/** Roof test for one surface point when the level has no roof labels: sloped or flat, well above the ground. */
export const looksLikeRoof = (ny: number, y: number, groundY: number) => ny > 0.35 && y > groundY + 3.5;

/**
 * @param nrm RGBA float per pixel: world normal xyz, a = label + 1 (0 = sky), top-down
 * @param pos RGBA float per pixel: world position xyz, top-down
 */
export function classifyView(nrm: Float32Array, pos: Float32Array, labels: string[], groundY: number): ViewClasses {
  const n = nrm.length / 4;
  const roofOf = roofLabels(labels);
  const label = new Int16Array(n).fill(-1);
  const roof = new Uint8Array(n);
  const floor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = nrm[4 * i + 3];
    if (a < 0.5) continue;
    const k = Math.round(a - 1);
    label[i] = k;
    const ny = nrm[4 * i + 1];
    if (roofOf ? roofOf[k] && ny > ROOF_MIN_NY : looksLikeRoof(ny, pos[4 * i + 1], groundY)) roof[i] = 1;
    else if (ny > 0.7) floor[i] = 1;
  }
  return { label, roof, floor };
}

const where = (cx: number, cy: number) => {
  const h = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'center';
  const v = cy < 0.33 ? 'top' : cy > 0.67 ? 'bottom' : '';
  return v ? (h === 'center' ? v : `${v} ${h}`) : h;
};

/** Parts inside `area` (all geometry when undefined), biggest first, with rough positions in the frame. */
export function describeView(c: ViewClasses, labels: string[], size: number, area?: Uint8Array): ViewDescription {
  const count = new Float64Array(labels.length);
  const sx = new Float64Array(labels.length);
  const sy = new Float64Array(labels.length);
  let total = 0, roofs = 0, floors = 0;
  for (let i = 0; i < c.label.length; i++) {
    const k = c.label[i];
    if (k < 0 || (area && !area[i])) continue;
    total++;
    roofs += c.roof[i];
    floors += c.floor[i];
    if (k < labels.length) {
      count[k]++;
      sx[k] += (i % size) / size;
      sy[k] += Math.floor(i / size) / size;
    }
  }
  const named = labels.length > 1;
  const parts = !named ? '' : labels
    .map((name, k) => ({ name, share: total ? count[k] / total : 0, cx: sx[k] / Math.max(1, count[k]), cy: sy[k] / Math.max(1, count[k]) }))
    .filter((p) => p.share >= 0.015)
    .sort((a, b) => b.share - a.share)
    .slice(0, 8)
    .map((p) => `${p.name} (${p.share > 0.4 ? 'most of the frame' : where(p.cx, p.cy)}${p.share < 0.04 ? ', small' : ''})`)
    .join(', ');
  return { parts, roofShare: total ? roofs / total : 0, floorShare: total ? floors / total : 0 };
}

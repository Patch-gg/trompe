import * as THREE from 'three';
import { floatTarget, type Gpu } from './gpu';
import { forEachTriangle, type Level } from './scene';
import { looksLikeRoof, ROOF_MIN_NY, roofLabels } from './semantics';
import type { ViewRenderer, ViewSpec } from './views';
import { makeCamera } from './views';

/**
 * Camera planning: sample where a player can stand, render cheap low-res probes from candidate cameras there,
 * then greedily keep the cameras that capture the most texture at good quality (a set cover over UV cells).
 */
export interface PlanOptions {
  eyeHeight: number;
  spacing: number;        // min distance between player sample points (m)
  fov: number;
  yaws: number;           // candidate headings per point
  pitchDeg: number;
  downYaws: number;       // extra candidates per point looking down at the floor (0 = none; models add clutter)
  downPitchDeg: number;
  maxViews: number;
  targetCoverage: number; // stop when this share of reachable cells is captured well
  probeSize: number;      // probe render size (px)
  grid: number;           // UV cells per side
  goodRatio: number;      // a cell counts as captured at >= this share of its best possible quality...
  goodAbs: number;        // ...or at this absolute quality (cos / distance; 0.12 = head-on from ~8 m)
  maxParallel: number;    // views per wave (1 = each view sees everything painted before it; best seams)
  aerial: number;         // cameras per ring around the level (outer walls, tops of props); up to 2x this are used; 0 = none
  roofs: number;          // max close cameras over the roofs, painted with a roof prompt (0 = none)
  roofDistance: number;   // m from a roof camera to the roof it looks at
  holes: number;          // max views in the final pass over texels nothing painted (behind props, tops of props)
  seed: number;
}

export const DEFAULT_PLAN: PlanOptions = {
  eyeHeight: 1.65, spacing: 4, fov: 90, yaws: 8, pitchDeg: 6, downYaws: 0, downPitchDeg: -40, maxViews: 36, targetCoverage: 0.97,
  probeSize: 96, grid: 256, goodRatio: 0.5, goodAbs: 0.12, maxParallel: 1, aerial: 0, roofs: 0, roofDistance: 15, holes: 0, seed: 7,
};

export interface Plan {
  points: THREE.Vector3[];          // player eye positions
  views: ViewSpec[];                // ordered for painting
  waves: number[][];                // indices into views; a wave is painted in parallel
  viewCells: CellList[];            // per ordered view
  qBest: Float32Array;
  grid: number;
  reachableCells: number;
  predicted: number[];              // predicted coverage after each ordered view
}

export interface CellList { cells: Int32Array; q: Float32Array }

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points on walkable surfaces with headroom, thinned to `spacing`, restricted to the main reachable areas. */
export const planStats: Record<string, number> = {};

export function samplePlayerPoints(level: Level, o: PlanOptions): THREE.Vector3[] {
  const rnd = mulberry32(o.seed);
  const cand: THREE.Vector3[] = [];
  const perArea = 4 / (o.spacing * o.spacing);
  const up = new THREE.Vector3(0, 1, 0);
  const ray = new THREE.Ray();
  forEachTriangle(level, (a, b, c, n, area) => {
    if (n.y < 0.7) return;
    let k = area * perArea;
    const count = Math.floor(k) + (rnd() < k - Math.floor(k) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      cand.push(new THREE.Vector3().copy(a).addScaledVector(new THREE.Vector3().subVectors(b, a), r1)
        .addScaledVector(new THREE.Vector3().subVectors(c, a), r2));
    }
  });
  planStats.candidates = cand.length;
  const ok: THREE.Vector3[] = [];
  for (const p of cand) {
    ray.origin.copy(p).addScaledVector(up, 0.05);
    ray.direction.copy(up);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit && hit.distance < o.eyeHeight + 0.3) continue;              // no headroom
    const eye = p.clone().addScaledVector(up, o.eyeHeight);
    ray.origin.copy(eye);
    ray.direction.set(0, -1, 0);
    const down = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!down || Math.abs(down.distance - o.eyeHeight) > 0.1) continue;  // something between eye and floor
    ok.push(eye);
  }
  planStats.standable = ok.length;
  const open = enclosed(level, ok);
  planStats.enclosed = open.length;
  // Poisson-disk thinning with a hash grid.
  const order = open.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const cell = o.spacing;
  const hash = new Map<string, THREE.Vector3[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const kept: THREE.Vector3[] = [];
  for (const i of order) {
    const p = open[i];
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell);
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dz = -1; dz <= 1 && !clash; dz++) {
        for (const q of hash.get(`${cx + dx},${cz + dz}`) ?? []) {
          if (Math.hypot(q.x - p.x, q.z - p.z) < o.spacing && Math.abs(q.y - p.y) < 2) { clash = true; break; }
        }
      }
    }
    if (clash) continue;
    kept.push(p);
    const k = key(p.x, p.z);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k)!.push(p);
  }
  planStats.thinned = kept.length;
  const main = mainAreas(level, kept, o);
  planStats.main = main.length;
  return main;
}

/**
 * Playable spaces are enclosed: from eye height, most horizontal directions hit a wall within 30 m. Rooftops and
 * prop tops look out over everything, so they drop out here. Relaxes when nothing qualifies (open terrain).
 */
function enclosed(level: Level, pts: THREE.Vector3[]): THREE.Vector3[] {
  const ray = new THREE.Ray();
  const inside = new Uint8Array(pts.length);
  const hits = pts.map((p, i) => {
    let n = 0, back = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      ray.origin.copy(p);
      ray.direction.set(Math.sin(a), 0, Math.cos(a));
      const h = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!h || h.distance >= 30) continue;
      if (h.face && h.face.normal.dot(ray.direction) > 0) back++;   // seeing a face from behind: inside a solid
      else n++;
    }
    if (back >= 3) inside[i] = 1;
    return n;
  });
  planStats.inside = inside.reduce((a, b) => a + b, 0);
  for (const min of [5, 3, 0]) {
    const keep = pts.filter((_, i) => !inside[i] && hits[i] >= min);
    if (keep.length >= Math.max(3, 0.25 * pts.length) || min === 0) return keep;
  }
  return pts;
}

/** Group points into areas a player can walk between (close, similar height, clear line of sight). */
/**
 * Can a player walk from a to b? Follows the floor in 0.4 m steps: no step up higher than 0.65 m (stairs are
 * fine, crates and walls are not), no drop over 1.5 m, and a clear line of sight at eye height.
 */
function walkable(level: Level, a: THREE.Vector3, b: THREE.Vector3, eye: number): boolean {
  const ray = new THREE.Ray();
  const d = a.distanceTo(b);
  ray.origin.copy(a);
  ray.direction.subVectors(b, a).normalize();
  const los = level.bvh.raycastFirst(ray, THREE.DoubleSide);
  if (los && los.distance < d - 0.05) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.4));
  let prev = a.y - eye;
  const top = Math.max(a.y, b.y) + 0.2;
  ray.direction.set(0, -1, 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ray.origin.set(a.x + (b.x - a.x) * t, top, a.z + (b.z - a.z) * t);
    const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) return false;
    const floor = hit.point.y;
    if (floor - prev > 0.65 || prev - floor > 1.5) return false;
    prev = floor;
  }
  return Math.abs(prev - (b.y - eye)) < 0.3;
}

/** Group points into areas a player can walk between and keep the main play area (plus any comparable ones). */
function mainAreas(level: Level, pts: THREE.Vector3[], o: PlanOptions): THREE.Vector3[] {
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reach = o.spacing * 2.5;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      if (a.distanceTo(b) > reach || Math.abs(a.y - b.y) > 3) continue;
      if (find(i) === find(j)) continue;
      if (walkable(level, a, b, o.eyeHeight)) parent[find(i)] = find(j);
    }
  }
  const size = new Map<number, number>();
  for (let i = 0; i < pts.length; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
  const best = Math.max(0, ...size.values());
  planStats.clusters = size.size;
  planStats.largest = best;
  return pts.filter((_, i) => (size.get(find(i)) ?? 0) >= Math.max(2, 0.3 * best));
}

export function candidateViews(points: THREE.Vector3[], o: PlanOptions): ViewSpec[] {
  const rnd = mulberry32(o.seed + 1);
  const out: ViewSpec[] = [];
  for (const p of points) {
    const offset = rnd() * (2 * Math.PI / o.yaws);
    for (let k = 0; k < o.yaws; k++) {
      out.push({ id: out.length, position: [p.x, p.y, p.z], yaw: offset + (2 * Math.PI * k) / o.yaws,
        pitch: THREE.MathUtils.degToRad(o.pitchDeg), fov: o.fov });
    }
    for (let k = 0; k < o.downYaws; k++) {
      out.push({ id: out.length, position: [p.x, p.y, p.z], yaw: offset + (2 * Math.PI * (k + 0.5)) / o.downYaws,
        pitch: THREE.MathUtils.degToRad(o.downPitchDeg), fov: o.fov });
    }
  }
  return out;
}

/**
 * Cameras around the level for surfaces no player sees: a high ring looking down into it (tops of props, ground
 * behind them) and a low ring just outside it facing the outer walls.
 */
export function aerialViews(level: Level, o: PlanOptions, startId: number): ViewSpec[] {
  const b = level.bounds;
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const r = 0.5 * Math.hypot(size.x, size.z);
  const out: ViewSpec[] = [];
  const look = (p: THREE.Vector3, at: THREE.Vector3, fov: number) => {
    const d = at.clone().sub(p).normalize();
    out.push({ id: startId + out.length, position: [p.x, p.y, p.z], yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(d.y), fov, kind: 'aerial' });
  };
  for (let k = 0; k < o.aerial; k++) {
    const a = (2 * Math.PI * k) / o.aerial + 0.3;
    look(new THREE.Vector3(c.x + Math.sin(a) * r * 0.9, b.max.y + r * 0.55, c.z + Math.cos(a) * r * 0.9), new THREE.Vector3(c.x, b.min.y, c.z), 70);
  }
  const low = b.min.y + Math.min(12, 0.45 * size.y);
  for (let k = 0; k < 2 * o.aerial; k++) {
    const a = (2 * Math.PI * k) / (2 * o.aerial);
    look(new THREE.Vector3(c.x + Math.sin(a) * r * 1.05, low, c.z + Math.cos(a) * r * 1.05), new THREE.Vector3(c.x, b.min.y + 3, c.z), 70);
  }
  return out;
}

/** Roof test per surface point: by part label when the level names its roofs, else by slope and height. */
export function roofTest(level: Level): (label: number, ny: number, y: number) => boolean {
  const byLabel = roofLabels(level.labels);
  const ground = level.bounds.min.y;
  return byLabel ? (label, ny) => !!byLabel[label] && ny > ROOF_MIN_NY : (_, ny, y) => looksLikeRoof(ny, y, ground);
}

/**
 * Close cameras over the roofs, drone-style: for points spread over the roof surfaces, look back at the slope
 * from the side it faces, `roofDistance` away and 50° down (flat roofs get four headings).
 */
export function roofViews(level: Level, o: PlanOptions, startId: number): ViewSpec[] {
  const isRoof = roofTest(level);
  const g = level.geometry;
  const pos = g.getAttribute('position'), lab = g.getAttribute('label');
  const rnd = mulberry32(o.seed + 2);
  const spacing = o.roofDistance * 0.55;
  const pts: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
  const tri = new THREE.Triangle();
  const n = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    tri.setFromAttributeAndIndices(pos, 3 * t, 3 * t + 1, 3 * t + 2);
    tri.getNormal(n);
    tri.getMidpoint(c);
    if (!isRoof(lab ? Math.round(lab.getX(3 * t)) : 0, n.y, c.y)) continue;
    const k = (4 * tri.getArea()) / (spacing * spacing);
    const count = Math.floor(k) + (rnd() < k - Math.floor(k) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const p = tri.a.clone().addScaledVector(new THREE.Vector3().subVectors(tri.b, tri.a), r1)
        .addScaledVector(new THREE.Vector3().subVectors(tri.c, tri.a), r2);
      if (pts.every((q) => q.p.distanceTo(p) >= spacing)) pts.push({ p, n: n.clone() });
    }
  }
  const pitch = THREE.MathUtils.degToRad(-50);
  const ray = new THREE.Ray();
  const out: ViewSpec[] = [];
  for (const { p, n: nn } of pts) {
    const h = Math.hypot(nn.x, nn.z);
    const base = Math.atan2(nn.x, nn.z);
    const yaws = h < 0.2 ? [0, 0.5, 1, 1.5].map((f) => base + f * Math.PI) : [base, base - 0.7, base + 0.7];
    for (const yaw of yaws) {
      const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const eye = p.clone().addScaledVector(dir, -o.roofDistance);
      ray.origin.copy(p).addScaledVector(nn, 0.05);
      ray.direction.copy(dir).negate();
      const hit = level.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < o.roofDistance) continue;   // something (a taller roof, the tower) is in the way
      out.push({ id: startId + out.length, position: [eye.x, eye.y, eye.z], yaw, pitch, fov: 60, kind: 'roof' });
    }
  }
  return out;
}

/**
 * Candidates for the final hole pass: looking down from 5 m above where players stand (ground hidden behind props
 * from eye height) and from the high ring (tops of props). The pass picks among them by the unpainted pixels each
 * actually sees.
 */
export function holeViews(level: Level, o: PlanOptions, points: THREE.Vector3[]): ViewSpec[] {
  const out: ViewSpec[] = [];
  const pitch = THREE.MathUtils.degToRad(-55);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  for (const p of points) {
    ray.origin.copy(p);
    const above = level.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (above && above.distance < 5.5) continue;   // under a roof or an arch: the camera would sit in it
    for (let k = 0; k < 4; k++) {
      out.push({ id: out.length, position: [p.x, p.y + 5, p.z], yaw: (k * Math.PI) / 2 + 0.4, pitch, fov: 75, kind: 'fill' });
    }
  }
  for (const v of aerialViews(level, { ...o, aerial: Math.max(o.aerial, 8) }, out.length).slice(0, Math.max(o.aerial, 8))) {
    out.push({ ...v, id: out.length, kind: 'fill' });
  }
  return out;
}

/**
 * Render each candidate at probe size and list the UV cells it sees with the best quality per cell. With `only`,
 * just the pixels it accepts count (part label, normal y, world y).
 */
export function probeCells(gpu: Gpu, views: ViewRenderer, specs: ViewSpec[], o: PlanOptions,
  only?: (label: number, ny: number, y: number) => boolean): CellList[] {
  const rt = floatTarget(o.probeSize, o.probeSize, { count: 3, depth: true });
  const G = o.grid;
  const scratch = new Float32Array(G * G);
  const out: CellList[] = [];
  for (const s of specs) {
    views.renderGeometry(makeCamera(s), rt);
    const px = gpu.readF32(rt, 2, false);
    const wp = only ? gpu.readF32(rt, 0, false) : null;
    const nr = only ? gpu.readF32(rt, 1, false) : null;
    const touched: number[] = [];
    for (let i = 0; i < px.length; i += 4) {
      const q = px[i + 2];
      if (!(q > 0)) continue;
      if (only && !only(Math.round(nr![i + 3] - 1), nr![i + 1], wp![i + 1])) continue;
      const cx = Math.min(G - 1, Math.max(0, Math.floor(px[i] * G)));
      const cy = Math.min(G - 1, Math.max(0, Math.floor(px[i + 1] * G)));
      const c = cy * G + cx;
      if (scratch[c] === 0) touched.push(c);
      if (q > scratch[c]) scratch[c] = q;
    }
    const cells = Int32Array.from(touched);
    const q = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) { q[i] = scratch[cells[i]]; scratch[cells[i]] = 0; }
    out.push({ cells, q });
  }
  rt.dispose();
  return out;
}

/** Greedy set cover, then an order where each view overlaps what's already painted, then parallel waves. */
export function selectViews(lists: CellList[], o: PlanOptions, aerial: boolean[] = [], existing?: Float32Array,
  skip?: Uint8Array) {
  const G2 = o.grid * o.grid;
  const qBest = new Float32Array(G2);
  for (const l of lists) for (let i = 0; i < l.cells.length; i++) qBest[l.cells[i]] = Math.max(qBest[l.cells[i]], l.q[i]);
  if (skip) for (let c = 0; c < G2; c++) if (skip[c]) qBest[c] = 0;   // another pass covers these (roofs)
  let reachable = 0;
  for (let c = 0; c < G2; c++) if (qBest[c] > 0) reachable++;
  const covered = new Uint8Array(G2);
  const good = (l: CellList, i: number) => qBest[l.cells[i]] > 0 && l.q[i] >= Math.min(o.goodRatio * qBest[l.cells[i]], o.goodAbs);
  let have = 0;
  if (existing) {
    // top-up: cells the texture already captures well don't need new views
    for (let c = 0; c < G2; c++) {
      if (qBest[c] > 0 && existing[c] >= Math.min(o.goodRatio * qBest[c], o.goodAbs)) { covered[c] = 1; have++; }
    }
  }
  const gain = (k: number) => {
    const l = lists[k];
    let g = 0;
    for (let i = 0; i < l.cells.length; i++) if (!covered[l.cells[i]] && good(l, i)) g++;
    return aerial[k] ? g * 0.5 : g;   // prefer what players see; aerial views pick up the rest
  };
  const base = covered.slice();     // what the existing texture already covers (top-up runs)
  // Lazy greedy: gains only shrink as coverage grows.
  const heap = lists.map((_, k) => ({ k, g: gain(k) })).sort((a, b) => b.g - a.g);
  const chosen: number[] = [];
  while (chosen.length < o.maxViews && heap.length && have / reachable < o.targetCoverage) {
    const top = heap.shift()!;
    top.g = gain(top.k);
    if (heap.length && top.g < heap[0].g) {
      let lo = 0, hi = heap.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (heap[mid].g > top.g) lo = mid + 1; else hi = mid; }
      heap.splice(lo, 0, top);
      continue;
    }
    if (top.g < Math.max(8, reachable * 0.002)) break;
    chosen.push(top.k);
    const l = lists[top.k];
    for (let i = 0; i < l.cells.length; i++) if (good(l, i) && !covered[l.cells[i]]) { covered[l.cells[i]] = 1; have++; }
  }
  if (!chosen.length) return { order: [] as number[], waves: [] as number[][], qBest, reachable, predicted: [] as number[] };
  // Order: start from the biggest view, then always take the one overlapping the painted area most.
  const painted = new Uint8Array(G2);
  if (existing) for (let c = 0; c < G2; c++) if (existing[c] > 0) painted[c] = 1;
  const overlap = (k: number) => { let n = 0; for (const c of lists[k].cells) if (painted[c]) n++; return n; };
  const paint = (k: number) => { for (const c of lists[k].cells) painted[c] = 1; };
  const ground = chosen.filter((k) => !aerial[k]);
  const air = chosen.filter((k) => aerial[k]);
  const order: number[] = [ground[0] ?? air[0]];
  paint(order[0]);
  const rest = new Set((ground.length ? ground : air).slice(1));
  while (rest.size) {
    let best = -1, bestScore = -1;
    for (const k of rest) {
      const ov = overlap(k) / Math.max(1, lists[k].cells.length);
      const score = ov > 0.08 ? 1 + ov * 0.1 + (1 - chosen.indexOf(k) / chosen.length) : ov;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    order.push(best);
    paint(best);
    rest.delete(best);
  }
  if (ground.length) for (const k of air) order.push(k);   // aerial views paint last, one at a time
  // Waves: views in a wave must not overlap each other, and (after the first) must touch painted texture.
  const waves: number[][] = [];
  const done = new Uint8Array(G2);
  if (existing) for (let c = 0; c < G2; c++) if (existing[c] > 0) done[c] = 1;
  const pending = order.map((_, i) => i);
  while (pending.length) {
    if (aerial[order[pending[0]]]) {
      const vi = pending.shift()!;
      waves.push([vi]);
      for (const c of lists[order[vi]].cells) done[c] = 1;
      continue;
    }
    const wave: number[] = [];
    const inWave = new Uint8Array(G2);
    for (let p = 0; p < pending.length && wave.length < o.maxParallel; p++) {
      const vi = pending[p];
      if (aerial[order[vi]]) break;
      const l = lists[order[vi]];
      let touchesDone = 0, clash = 0;
      for (const c of l.cells) { if (done[c]) touchesDone++; if (inWave[c]) clash++; }
      const first = waves.length === 0 && wave.length === 0;
      if (!first && waves.length === 0 && !existing) break;          // the very first view paints alone
      if (!first && touchesDone < 0.05 * l.cells.length && wave.length) continue;
      if (clash > 0.02 * l.cells.length) continue;
      wave.push(vi);
      for (const c of l.cells) inWave[c] = 1;
    }
    if (!wave.length) wave.push(pending[0]);
    for (const vi of wave) { pending.splice(pending.indexOf(vi), 1); for (const c of lists[order[vi]].cells) done[c] = 1; }
    waves.push(wave);
  }
  // Predicted coverage curve in paint order.
  const cov = base.slice();
  let n = 0;
  for (let c = 0; c < G2; c++) n += cov[c];
  const predicted = order.map((k) => {
    const l = lists[k];
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(l, i)) { cov[l.cells[i]] = 1; n++; }
    return n / reachable;
  });
  return { order, waves, qBest, reachable, predicted };
}

export function plan(gpu: Gpu, level: Level, views: ViewRenderer, opts: Partial<PlanOptions> = {}, existing?: Float32Array): Plan {
  const o = { ...DEFAULT_PLAN, ...opts };
  const G2 = o.grid * o.grid;
  const points = samplePlayerPoints(level, o);
  if (!points.length) throw new Error('found nowhere to stand: is the level Y-up with walkable floors?');
  // Three passes, each with its own budget: the players' views, close views over the roofs, and the aerial ring
  // for what's left (outer walls, tops of props). Players' and aerial views leave roofs to the roof pass.
  const ground = candidateViews(points, o);
  const groundLists = probeCells(gpu, views, ground, o);
  const roofCands = o.roofs > 0 ? roofViews(level, o, 0) : [];
  const roofLists = probeCells(gpu, views, roofCands, o, roofTest(level));
  const air = o.aerial > 0 ? aerialViews(level, o, 0) : [];
  const airLists = probeCells(gpu, views, air, o);
  let roofCells: Uint8Array | undefined;
  if (roofCands.length) {
    roofCells = new Uint8Array(G2);
    for (const l of roofLists) for (const c of l.cells) roofCells[c] = 1;
  }
  const sel = selectViews(groundLists, o, [], existing, roofCells);
  const roofSel = roofCands.length
    ? selectViews(roofLists, { ...o, maxViews: o.roofs, targetCoverage: 0.98 }, roofCands.map(() => true), existing) : null;
  // the aerial ring only fills in after the players' views
  const have = existing ? existing.slice() : new Float32Array(G2);
  for (const k of sel.order) { const l = groundLists[k]; for (let i = 0; i < l.cells.length; i++) have[l.cells[i]] = Math.max(have[l.cells[i]], l.q[i]); }
  const airSel = air.length ? selectViews(airLists, { ...o, maxViews: 2 * o.aerial }, air.map(() => true), have, roofCells) : null;
  const picked = [
    ...sel.order.map((k) => ({ spec: ground[k], cells: groundLists[k] })),
    ...(roofSel?.order.map((k) => ({ spec: roofCands[k], cells: roofLists[k] })) ?? []),
    ...(airSel?.order.map((k) => ({ spec: air[k], cells: airLists[k] })) ?? []),
  ];
  // Paint order as listed; roof and aerial views each paint alone.
  const nPlay = sel.order.length;
  const waves = [...sel.waves, ...picked.slice(nPlay).map((_, j) => [nPlay + j])];
  // Predicted coverage over everything any candidate sees well, in paint order.
  const qAll = new Float32Array(G2);
  for (const l of [...groundLists, ...roofLists, ...airLists]) for (let i = 0; i < l.cells.length; i++) qAll[l.cells[i]] = Math.max(qAll[l.cells[i]], l.q[i]);
  const good = (c: number, q: number) => q >= Math.min(o.goodRatio * qAll[c], o.goodAbs);
  const cov = new Uint8Array(G2);
  let reachable = 0, n = 0;
  for (let c = 0; c < G2; c++) {
    if (!(qAll[c] > 0)) continue;
    reachable++;
    if (existing && good(c, existing[c])) { cov[c] = 1; n++; }
  }
  const predicted = picked.map(({ cells: l }) => {
    for (let i = 0; i < l.cells.length; i++) if (!cov[l.cells[i]] && good(l.cells[i], l.q[i])) { cov[l.cells[i]] = 1; n++; }
    return reachable ? n / reachable : 0;
  });
  planStats.roofCandidates = roofCands.length;
  planStats.roofViews = roofSel?.order.length ?? 0;
  planStats.aerialViews = airSel?.order.length ?? 0;
  return { points, views: picked.map((p, i) => ({ ...p.spec, id: i })), waves, viewCells: picked.map((p) => p.cells), qBest: qAll,
    grid: o.grid, reachableCells: reachable, predicted };
}

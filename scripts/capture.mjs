#!/usr/bin/env node
// Render the demo video's 3D frames from a saved run (no model calls), straight off the WebGL canvas.
//   node scripts/capture.mjs --run village-02 --level samples/village.glb --out video/out
// Writes <out>/frames/NNNNN.jpg for every frame with 3D content and <out>/timeline.json describing all frames
// (sections, captions, counters, picture-in-picture view) for video/compose.py.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowser, openApp, ROOT, startServer } from './browser.mjs';

const { values: a } = parseArgs({ options: {
  run: { type: 'string', default: 'village-02' }, level: { type: 'string', default: 'samples/village.glb' },
  out: { type: 'string', default: 'video/out' }, fps: { type: 'string', default: '30' }, atlas: { type: 'string', default: '8192' },
  only: { type: 'string' }, every: { type: 'string', default: '1' },
  // the plan's spots and cameras; black keeps the brand's one pink thing per view (the patch on the frame)
  'overlay-color': { type: 'string', default: '#000000' },
} });
const FPS = +a.fps;
const OUT = path.resolve(a.out);
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

// ---------------------------------------------------------------- camera helpers (three.js coords, Y up)
const lerp = (x, y, t) => x + (y - x) * t;
const lerp3 = (p, q, t) => p.map((v, i) => lerp(v, q[i], t));
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const CENTER = [0, 0.5, -1];
const orbit = (deg, height, radius, fov = 42) => {
  const r = (deg * Math.PI) / 180;
  return { position: [CENTER[0] + Math.sin(r) * radius, height, CENTER[2] + Math.cos(r) * radius], target: CENTER, fov };
};
const move = (p0, p1, t0, t1, fov, t) => ({ position: lerp3(p0, p1, t), target: lerp3(t0, t1, t), fov });
const quad = (a, b, c, t) => lerp3(lerp3(a, b, t), lerp3(b, c, t), t);
const bezier = (p0, p1, p2, q0, q1, q2, fov, t) => ({ position: quad(p0, p1, p2, t), target: quad(q0, q1, q2, t), fov });

// ---------------------------------------------------------------- timeline (cut to the soundtrack's bars)
const beats = JSON.parse(fs.readFileSync(path.join(ROOT, 'video', 'audio', 'beats.json'), 'utf8'));
const T = beats.period;
const BAR = beats.bars;                     // downbeat times (s)
const paintSlots = (W, beatsTotal) => {
  // slot 0 (2 beats): the first wave alone; then one-beat slots share the remaining waves
  const slots = [{ from: 0, to: 1, beats: 2 }];
  const rest = beatsTotal - 2;
  for (let j = 0; j < rest; j++) {
    const from = 1 + Math.floor((j * (W - 1)) / rest), to = 1 + Math.floor(((j + 1) * (W - 1)) / rest);
    slots.push({ from, to, beats: 1 });
  }
  return slots;
};
const HOOK_CAM = (t) => move([-8, 1.7, 8.6], [4.5, 1.7, 7.2], [-3, 5, -14], [2.5, 5, -14], 66, t);
const SWEEP = [BAR[0], BAR[0] + 3.4 * T];                 // sweep from the first downbeat, ~3.4 beats long
const SECTIONS = [
  { name: 'hook', start: 0, end: BAR[2], caption: null,
    frame: (t, d, sec) => {
      const time = t * (sec.end - sec.start);
      const r = Math.min(1, Math.max(0, (time - SWEEP[0]) / (SWEEP[1] - SWEEP[0])));
      const cam = HOOK_CAM(easeInOut(t));
      if (r <= 0) return { mode: 'clay', camera: cam, waves: 0, overlay: null };
      return { mode: 'lit', camera: cam, waves: 0, until: d.waves.length, reveal: r < 1 ? r : 0.9999,
        revealOrigin: cam.position, skyMix: smooth(r), overlay: null };
    } },
  { name: 'montage', start: BAR[2], end: BAR[4], caption: null,
    frame: (t, d, sec) => {
      const s = sec.start + t * (sec.end - sec.start);
      const first = s < BAR[3];
      const u = first ? (s - BAR[2]) / (BAR[3] - BAR[2]) : (s - BAR[3]) / (BAR[4] - BAR[3]);
      const cam = first
        ? move([-10, 1.7, -8.5], [-10, 1.7, -18.5], [-10, 2.6, -30], [-10, 2.8, -31], 70, easeInOut(u))
        : move([5, 1.7, 0.6], [16.5, 1.7, 0.1], [31, 2.4, 0.3], [31, 2.6, 0], 68, easeInOut(u));
      return { mode: 'lit', aiSky: true, camera: cam, waves: d.waves.length, reveal: 0, overlay: null, _shot: first ? 0 : 1 };
    } },
  { name: 'plan', start: BAR[4], end: BAR[6], caption: ['01', 'Plan cameras where a player can stand'],
    frame: (t, d) => ({ mode: 'clay', camera: orbit(lerp(200, 222, smooth(t)), lerp(34, 36, t), 22, 52), waves: 0,
      overlay: { points: d.points * smooth(Math.min(1, t / 0.35)), frusta: d.views * smooth(Math.max(0, Math.min(1, (t - 0.3) / 0.5))) } }) },
  { name: 'paint', start: BAR[6], end: BAR[12], caption: ['02', 'Paint each view with an image model, project it back'],
    frame: (t, d, sec) => {
      const W = d.waves.length;
      const beatsTotal = Math.round((sec.end - sec.start) / T);
      const slots = paintSlots(W, beatsTotal);
      let b = (t * (sec.end - sec.start)) / T;
      let k = 0;
      while (k < slots.length - 1 && b >= slots[k].beats) { b -= slots[k].beats; k++; }
      const slot = slots[k];
      const r = Math.min(1, b / slot.beats);
      const done = t >= 0.999;
      const cam = orbit(lerp(222, 330, t), lerp(36, 30, smooth(t)), lerp(22, 30, smooth(t)), 52);
      if (done || slot.from >= slot.to) return { mode: 'lit', aiSky: false, camera: cam, waves: done ? W : slot.from, reveal: 0, overlay: null, _slot: k, _r: 1, _slotWaves: [slot.from, slot.to] };
      return { mode: 'lit', aiSky: false, camera: cam, waves: slot.from, until: slot.to, reveal: smooth(r), overlay: null,
        _slot: k, _r: r, _slotWaves: [slot.from, slot.to] };
    } },
  { name: 'result', start: BAR[12], end: BAR[15], caption: ['03', 'One texture, real shadows · glTF out'],
    frame: (t, d, sec) => {
      const s = sec.start + t * (sec.end - sec.start);
      const craneEnd = BAR[14];
      if (s < craneEnd) {
        const u = (s - sec.start) / (craneEnd - sec.start);
        return { mode: 'lit', aiSky: true, camera: bezier([2, 1.8, 6], [2.5, 22, 7], [16, 34, 36], [-1, 3, -8], [0, 1.5, -5], [0, 0, -3], lerp(66, 46, smooth(u)), easeInOut(u)),
          waves: d.waves.length, reveal: 0, overlay: null, _shot: 0 };
      }
      const u = (s - craneEnd) / (sec.end - craneEnd);
      const deg = lerp(31, 52, u), r = Math.hypot(16, 39);
      // the sun swings round while the camera orbits: the shadows are real lighting, not painted on
      return { mode: 'lit', aiSky: true, camera: { position: [Math.sin(deg * Math.PI / 180) * r, 34, Math.cos(deg * Math.PI / 180) * r - 3], target: [0, 0, -3], fov: 46 },
        sun: { azimuth: lerp(45, 165, easeInOut(u)), elevation: lerp(50, 38, u) }, waves: d.waves.length, reveal: 0, overlay: null, _shot: 1 };
    } },
  { name: 'end', start: BAR[15], end: BAR[15] + 6.2 },
];

// ---------------------------------------------------------------- render
const { server, url } = await startServer();
const browser = await launchBrowser();
const t0 = Date.now();
try {
  const page = await openApp(browser, url, { width: 1920, height: 1080, onLog: (s) => console.log(s) });
  const d = await page.evaluate(([lvl, run, atlas, color]) => window.trompe.demo.setup(lvl, run, +atlas, 1920, 1080, color),
    [a.level, a.run, a.atlas, a['overlay-color']]);
  console.log(`run ${a.run}: ${d.views} views in ${d.waves.length} waves from ${d.points} spots, $${d.cost.toFixed(2)}, ${d.seconds.toFixed(0)} s`);
  const timeline = { fps: FPS, width: 1920, height: 1080, run: a.run, data: d, frames: [] };
  const total = Math.round(SECTIONS.at(-1).end * FPS);
  const viewsIn = (from, to) => d.waves.slice(from, to).reduce((s, x) => s + x.views.length, 0);
  const costIn = (from, to) => d.waves.slice(from, to).reduce((s, x) => s + x.cost, 0);
  for (let n = 0; n < total; n++) {
    const time = n / FPS;
    const sec = SECTIONS.find((x) => time >= x.start && time < x.end) ?? SECTIONS.at(-1);
    const t = Math.min(1, (time - sec.start) / (sec.end - sec.start));
    const meta = { i: n, time: +time.toFixed(4), section: sec.name, t: +t.toFixed(4), caption: sec.caption ?? null,
      sectionStart: sec.start, sectionEnd: sec.end };
    if (sec.frame && (!a.only || a.only === sec.name) && n % +a.every === 0) {
      const f = sec.frame(t, d, sec);
      if (sec.name === 'paint') {
        const [from, to] = f._slotWaves;
        const partial = f._r >= 1 ? 1 : f._r;
        const views = viewsIn(0, from) + Math.floor(partial * viewsIn(from, to));
        const cost = costIn(0, from) + partial * costIn(from, to);
        const shown = Math.min(d.waves.length - 1, Math.max(0, from));
        meta.paint = { slot: f._slot, slotWaves: [from, to], reveal: +f._r.toFixed(3), views, cost: +cost.toFixed(3),
          pip: d.waves[shown].views[0], predicted: to > 0 ? Math.max(...d.waves.slice(0, Math.max(1, Math.round(from + partial * (to - from)))).map((w) => w.predicted)) : 0,
          elapsed: +(d.seconds * Math.min(1, (from + partial * (to - from)) / d.waves.length)).toFixed(1) };
      }
      if (sec.name === 'result' || sec.name === 'montage') meta.shot = f._shot;
      const url64 = await page.evaluate((spec) => window.trompe.demo.frame(spec), f);
      meta.frame = `${String(n).padStart(5, '0')}.jpg`;
      fs.writeFileSync(path.join(OUT, 'frames', meta.frame), Buffer.from(url64.split(',')[1], 'base64'));
    }
    timeline.frames.push(meta);
    if (n % 90 === 0) console.log(`frame ${n}/${total} (${sec.name}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  timeline.sections = SECTIONS.map(({ name, start, end, caption }) => ({ name, start, end, caption: caption ?? null }));
  timeline.beats = beats;
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline));
  console.log(`wrote ${timeline.frames.length} frames' timeline to ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}

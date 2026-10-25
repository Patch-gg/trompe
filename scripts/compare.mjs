#!/usr/bin/env node
// Render the same shots from several saved runs (no model calls), for side-by-side comparisons.
//   node scripts/compare.mjs --runs village-03,village-04 --level samples/village.glb --out runs/compare
// Shots default to the demo video's cameras; --shots takes a JSON file of [{ name, position, target, fov }].
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launchBrowser, openApp, startServer } from './browser.mjs';

const { values: a } = parseArgs({ options: {
  runs: { type: 'string' }, level: { type: 'string', default: 'samples/village.glb' }, out: { type: 'string', default: 'runs/compare' },
  shots: { type: 'string' }, atlas: { type: 'string', default: '8192' }, width: { type: 'string', default: '1600' },
  height: { type: 'string', default: '900' }, mode: { type: 'string', default: 'textured' },
} });
const SHOTS = a.shots ? JSON.parse(fs.readFileSync(a.shots, 'utf8')) : [
  { name: 'hook', position: [-8, 1.7, 8.6], target: [-3, 5, -14], fov: 66 },
  { name: 'plaza', position: [4.5, 1.7, 7.2], target: [2.5, 5, -14], fov: 66 },
  { name: 'alley-a', position: [-10, 1.7, -11], target: [-10, 2.6, -30], fov: 70 },
  { name: 'alley-b', position: [9, 1.7, 0.4], target: [31, 2.4, 0.3], fov: 68 },
  { name: 'arcade', position: [-3, 1.7, -6], target: [-8, 2.5, -22], fov: 70 },
  { name: 'roofs', position: [12.3, 17.2, 7.5], target: [2.3, 2, -8.5], fov: 60 },
  { name: 'crane', position: [16, 34, 36], target: [0, 0, -3], fov: 46 },
];
fs.mkdirSync(a.out, { recursive: true });
const { server, url } = await startServer();
const browser = await launchBrowser();
try {
  const page = await openApp(browser, url, { width: +a.width, height: +a.height, onLog: (s) => console.log(s) });
  for (const run of a.runs.split(',')) {
    await page.evaluate(([l, atlas]) => window.trompe.load(`/${l}`, { atlasSize: +atlas }), [a.level, a.atlas]);
    console.log(run, await page.evaluate((r) => window.trompe.loadRun(r), run));
    for (const s of SHOTS) {
      const dataUrl = await page.evaluate((o) => window.trompe.snapshot(o), { ...s, mode: a.mode, overlay: false,
        width: +a.width, height: +a.height });
      fs.writeFileSync(path.join(a.out, `${run}_${s.name}${a.mode === 'textured' ? '' : `_${a.mode}`}.jpg`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  }
  console.log(`wrote ${SHOTS.length} shots per run to ${a.out}`);
} finally {
  await browser.close();
  await server.close();
}

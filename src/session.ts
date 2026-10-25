import * as THREE from 'three';
import { INDOOR, OUTDOOR, OVERCAST, type Lighting } from './core/clay';
import { Engine } from './core/engine';
import { exportGlb } from './core/export';
import { Gpu } from './core/gpu';
import { toBlob, urlToRGBA } from './core/image';
import { runPipeline, type PipelineEvent, type PipelineOptions, type RunRecord, type ViewRecord } from './core/pipeline';
import { plan as makePlan, type Plan, type PlanOptions } from './core/planner';
import { loadLevel, type Level } from './core/scene';
import { MODELS } from './providers/models';
import type { ViewSpec } from './core/views';
import { Viewer } from './core/viewer';

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR };

/** One loaded level with its engine and viewer: the object both the UI and the headless API drive. */
export class Session {
  readonly gpu: Gpu;
  level?: Level;
  engine?: Engine;
  viewer?: Viewer;
  plan?: Plan;
  record?: RunRecord;
  private abort?: AbortController;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gpu = new Gpu(canvas);
  }

  async load(source: string | ArrayBuffer, name: string, lighting: Lighting = OUTDOOR, atlasSize = 4096, viewSize = 1024) {
    this.viewer?.controls.dispose();
    this.engine?.atlas.dispose();
    this.level = await loadLevel(source, name);
    this.engine = new Engine(this.gpu, this.level, { lighting, atlasSize, viewSize });
    this.viewer = new Viewer(this.engine, this.canvas);
    this.plan = undefined;
    this.record = undefined;
    return { triangles: this.level.triangles, area: Math.round(this.level.surfaceArea) };
  }

  setLighting(l: Lighting) {
    if (!this.engine || !this.viewer) return;
    this.engine.clay.setLighting(l);
    this.viewer.syncLighting();
  }

  makePlan(opts: Partial<PlanOptions> = {}) {
    if (!this.engine) throw new Error('load a level first');
    this.plan = makePlan(this.gpu, this.engine.level, this.engine.views, opts);
    this.viewer!.showPlan(this.plan.points, this.plan.views);
    return this.plan;
  }

  async run(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void) {
    if (!this.engine || !this.viewer) throw new Error('load a level first');
    this.abort = new AbortController();
    this.engine.atlas.reset();
    this.viewer.sky.reset();
    this.viewer.setMode('textured');
    const record = await runPipeline(this.engine, opts, (e) => {
      if (e.type === 'planned') { this.plan = e.plan; this.viewer!.showPlan(e.plan.points, e.plan.views); }
      if (e.type === 'view-done') this.addSky(e.view);
      if (e.type === 'done') this.viewer!.sky.finish();
      this.viewer!.dirty = true;
      onEvent(e);
    }, this.abort.signal, this.plan);
    this.record = record;
    return record;
  }

  /** Extend the current run: plan views only where the texture is still missing or poor, paint them on top. */
  async topUp(opts: Partial<PipelineOptions>, onEvent: (e: PipelineEvent) => void) {
    if (!this.engine || !this.viewer || !this.record || !this.plan) throw new Error('load a run first');
    this.abort = new AbortController();
    const grid = opts.plan?.grid ?? 256;
    const existing = this.engine.atlas.cellQuality(grid);
    const plan = makePlan(this.gpu, this.engine.level, this.engine.views, { ...opts.plan, grid }, existing);
    const prior = this.record;
    const record = await runPipeline(this.engine, opts, (e) => {
      if (e.type === 'planned') this.viewer!.showPlan(e.plan.points, e.plan.views);
      if (e.type === 'view-done') this.addSky(e.view);
      if (e.type === 'done') this.viewer!.sky.finish();
      this.viewer!.dirty = true;
      onEvent(e);
    }, this.abort.signal, plan, { views: prior.views, cost: prior.cost, seconds: prior.seconds, plan: this.plan });
    this.record = record;
    this.plan = record.plan;
    return record;
  }

  stop() {
    this.abort?.abort();
  }

  private addSky(v: { spec: ViewSpec; model: string; comp: Uint8ClampedArray }) {
    // only views whose model painted the whole frame: masked fills leave the clay sky as it was
    if (v.spec.kind === 'roof' || MODELS[v.model]?.mask) return;
    this.viewer!.sky.addView(v.spec, v.comp, this.engine!.geometryMask(v.spec), this.engine!.size);
  }

  /** Textured GLB of the level (unlit material with the baked texture). */
  async exportGlb(): Promise<ArrayBuffer> {
    if (!this.engine) throw new Error('nothing to export');
    return exportGlb(this.engine);
  }

  /** Save a run (metadata + every view's images + texture + GLB) through the dev server. */
  async saveRun(id: string, onProgress?: (msg: string) => void) {
    const r = this.record;
    if (!r || !this.engine) throw new Error('no run to save');
    const S = this.engine.size;
    const put = async (file: string, body: Blob | string) => {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/${file}`, { method: 'POST', body });
      if (!res.ok) throw new Error(`saving ${file} failed: ${res.status}`);
    };
    const meta = {
      level: r.level, options: r.options, lighting: this.engine.clay.lighting, cost: r.cost, seconds: r.seconds,
      plan: { points: r.plan.points.map((p) => p.toArray()), views: r.plan.views, waves: r.plan.waves, predicted: r.plan.predicted },
      views: r.views.map(({ clay: _c, state: _s, edit: _e, gen: _g, comp: _p, ...rest }) => rest),
    };
    await put('run.json', JSON.stringify(meta, null, 1));
    for (const v of r.views) {
      if (!v.state.length) continue;   // loaded from disk for a top-up: its files are already there
      onProgress?.(`view ${v.index}`);
      await put(`view_${v.index}_clay.jpg`, await toBlob(v.clay, S, S, 'image/jpeg', 0.92));
      await put(`view_${v.index}_state.jpg`, await toBlob(v.state, S, S, 'image/jpeg', 0.92));
      await put(`view_${v.index}_gen.jpg`, await toBlob(v.gen, S, S, 'image/jpeg', 0.92));
      await put(`view_${v.index}_comp.png`, await toBlob(v.comp, S, S, 'image/png'));
    }
    onProgress?.('texture');
    const { data, size } = this.engine.atlas.readBytes();
    await put('texture.png', await toBlob(data, size, size, 'image/png'));
    const sky = this.viewer!.sky;
    await put('sky.jpg', await toBlob(sky.data, sky.width, sky.height, 'image/jpeg', 0.92));
    onProgress?.('glb');
    await put('level_textured.glb', new Blob([await this.exportGlb()], { type: 'model/gltf-binary' }));
  }

  /** Load a saved run and rebuild its texture (no model calls). Returns the view records without images. */
  async loadRun(id: string) {
    if (!this.engine || !this.viewer) throw new Error('load the level first');
    const meta = await (await fetch(`/runs/${id}/run.json`)).json();
    const S = this.engine.size;
    const views: ViewRecord[] = [];
    for (const v of meta.views) {
      const comp = await urlToRGBA(`/runs/${id}/view_${v.index}_comp.png`, S, S);
      views.push({ ...v, comp, clay: new Uint8ClampedArray(0), state: new Uint8ClampedArray(0),
        edit: new Uint8Array(0), gen: new Uint8ClampedArray(0) });
    }
    const points = (meta.plan.points as number[][]).map((p) => new THREE.Vector3(...p));
    this.plan = { ...meta.plan, points } as Plan;
    this.record = { level: meta.level, options: meta.options, plan: this.plan!, views, cost: meta.cost, seconds: meta.seconds };
    this.engine.replay(views);
    this.viewer.sky.reset();
    for (const v of views) this.addSky(v);
    this.viewer.sky.finish();
    return meta;
  }
}

export { INDOOR, OUTDOOR };

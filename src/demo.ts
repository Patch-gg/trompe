import * as THREE from 'three';
import { OUTDOOR } from './core/clay';
import { floatTarget, passMaterial } from './core/gpu';
import { makeCamera } from './core/views';
import type { ViewRecord } from './core/pipeline';
import type { Session } from './session';

const COPY = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`;

export interface FrameSpec {
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  mode: 'clay' | 'textured' | 'lit';
  /** Paint progress: waves fully applied, plus the reveal progress (0-1) of the next wave. */
  waves?: number;
  reveal?: number;
  until?: number;
  overlay?: { points: number; frusta: number } | null;
  aiSky?: boolean;
  /** 0 = flat clay sky, 1 = the AI-matched sky (only when it has been built). */
  skyMix?: number;
  /** Override where a reveal sweeps out from (defaults to the revealed views' centroid). */
  revealOrigin?: [number, number, number];
  /** Display sun (degrees); the lit display's shadows follow it. Defaults to the outdoor preset's sun. */
  sun?: { azimuth: number; elevation: number };
  quality?: number;
}

/**
 * Deterministic frames for the demo video: replays a saved run wave by wave (no model calls) and renders the
 * viewer from scripted cameras straight off the canvas, so no browser UI ends up in the video.
 */
export class Demo {
  private steps: ViewRecord[] = [];
  private waves: ViewRecord[][] = [];
  private applied = 0;              // waves applied to the atlas
  private revealing = -1;           // first wave of the group currently being revealed
  private revealEnd = -1;
  private skyReady = false;
  private before?: THREE.WebGLRenderTarget;
  private readonly copy = passMaterial(COPY, { src: { value: null } });

  constructor(private readonly session: Session) {}

  async setup(level: string, run: string, atlasSize = 8192, width = 1920, height = 1080, overlayColor = '#F53CD1') {
    const s = this.session;
    await s.load(`/${level}`, level.split('/').pop()!.replace(/\.\w+$/, ''), undefined, atlasSize);
    await s.loadRun(run);
    this.steps = s.record!.views;
    this.skyReady = (s.viewer!.sky.mesh.material as THREE.ShaderMaterial).uniforms.has.value > 0;
    const byWave = new Map<number, ViewRecord[]>();
    for (const v of this.steps) byWave.set(v.wave, [...(byWave.get(v.wave) ?? []), v]);
    this.waves = [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!);
    s.engine!.atlas.reset();
    this.applied = 0;
    this.revealing = -1;
    const size = s.engine!.atlas.size;
    this.before?.dispose();
    this.before = floatTarget(size, size, { half: true, linear: true });
    s.viewer!.texMaterial.uniforms.before.value = this.before.texture;
    s.viewer!.showPlan(s.plan!.points, s.plan!.views, 1.6, overlayColor);
    s.viewer!.resize(width, height);
    return {
      waves: this.waves.map((w) => ({ views: w.map((v) => v.index), models: w.map((v) => v.model),
        origin: this.origin(w).toArray(), cost: w.reduce((a, v) => a + v.price, 0), predicted: Math.max(...w.map((v) => v.predicted)) })),
      points: s.plan!.points.length, views: s.record!.views.length, cost: s.record!.cost, seconds: s.record!.seconds,
    };
  }

  private origin(w: ViewRecord[]) {
    const o = new THREE.Vector3();
    for (const v of w) o.add(new THREE.Vector3(...v.spec.position));
    return o.divideScalar(w.length);
  }

  private applyWave(i: number) {
    for (const v of this.waves[i]) this.session.engine!.paint(v.spec, v.comp);
  }

  /**
   * Bring the atlas to `waves` complete waves. With `reveal` > 0, waves [waves, until) are applied on top and swept
   * in from their cameras' centroid (reveal 0-1).
   */
  private advance(waves: number, reveal: number, until: number) {
    const e = this.session.engine!;
    const n = this.waves.length;
    const target = Math.min(waves, n);
    const end = Math.min(Math.max(until, target + 1), n);
    const holding = this.revealing >= 0;
    if (target < this.applied || (holding && target < this.revealing)) {
      e.atlas.reset();
      this.applied = 0;
      this.revealing = -1;
    }
    if (this.revealing >= 0 && (target > this.revealing || reveal <= 0 || this.revealEnd !== end)) {
      // the held group is complete now (its waves are already in the atlas)
      this.applied = this.revealEnd;
      this.revealing = -1;
    }
    while (this.applied < target) this.applyWave(this.applied++);
    const u = this.session.viewer!.texMaterial.uniforms;
    if (reveal > 0 && target < n) {
      if (this.revealing !== target) {
        this.copy.uniforms.src.value = e.atlas.display.texture;
        e.gpu.pass(this.copy, this.before!);
        for (let w = target; w < end; w++) this.applyWave(w);
        this.revealing = target;
        this.revealEnd = end;
      }
      const b = this.session.level!.bounds;
      const reach = b.getSize(new THREE.Vector3()).length();
      u.useBefore.value = 1;
      u.revealOrigin.value.copy(this.origin(this.waves.slice(target, end).flat()));
      u.revealRadius.value = reveal * reach * 0.9;
    } else {
      u.useBefore.value = 0;
    }
  }

  /** Render one frame and return it as a JPEG data URL. */
  frame(f: FrameSpec): string {
    const v = this.session.viewer!;
    if (f.waves !== undefined) this.advance(f.waves, f.reveal ?? 0, f.until ?? f.waves + 1);
    if (f.revealOrigin) v.texMaterial.uniforms.revealOrigin.value.set(...f.revealOrigin);
    v.aiSky = f.aiSky ?? true;
    // the video shows every mode under the same sunny display light; the paint light can be overcast
    v.displayLighting = { ...OUTDOOR, sunAzimuth: f.sun?.azimuth ?? OUTDOOR.sunAzimuth, sunElevation: f.sun?.elevation ?? OUTDOOR.sunElevation };
    v.setMode(f.mode);
    const skyU = (v.sky.mesh.material as THREE.ShaderMaterial).uniforms;
    skyU.has.value = this.skyReady && f.mode !== 'lit' ? (f.skyMix ?? 1) : 0;
    if (f.skyMix !== undefined && f.mode === 'textured') v.sky.mesh.visible = true;
    v.overlay.visible = !!f.overlay;
    if (f.overlay) v.setOverlayCounts(f.overlay.points, f.overlay.frusta);
    const cam = v.camera;
    cam.fov = f.camera.fov;
    cam.position.set(...f.camera.position);
    cam.lookAt(...f.camera.target);
    cam.updateProjectionMatrix();
    v.render(cam);
    return this.session.canvas.toDataURL('image/jpeg', f.quality ?? 0.93);
  }

  /** Where each planned camera sits, for scripting moves near them. */
  viewSpecs() {
    return this.session.plan!.views.map((s) => {
      const c = makeCamera(s);
      return { position: c.position.toArray(), dir: c.getWorldDirection(new THREE.Vector3()).toArray() };
    });
  }
}

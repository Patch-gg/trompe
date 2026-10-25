import * as THREE from 'three';
import { distanceTo } from './composite';
import type { ViewSpec } from './views';
import { makeCamera } from './views';

const BINS = 32;
const LO = 0.15;          // lowest elevation sampled (~9°); lower is extended from here
const HI = Math.PI / 2;

/**
 * Backdrop matched to the generated images: the average sky colour per elevation, taken only from sky pixels far
 * from any geometry (models like to extend roofs past the real silhouette, so pixels near it are unreliable).
 */
export class SkyDome {
  readonly width = 2048;
  readonly height = 1024;
  /** Equirectangular export of the gradient (RGBA8, row 0 = zenith). */
  readonly data = new Uint8ClampedArray(2048 * 1024 * 4);
  private readonly sum = new Float64Array(BINS * 3);
  private readonly count = new Float64Array(BINS);
  private readonly gradient: THREE.DataTexture;
  readonly mesh: THREE.Mesh;

  constructor() {
    this.gradient = new THREE.DataTexture(new Uint8Array(BINS * 4), BINS, 1, THREE.RGBAFormat);
    this.gradient.colorSpace = THREE.SRGBColorSpace;
    this.gradient.magFilter = THREE.LinearFilter;
    this.gradient.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { gradient: { value: this.gradient }, fallbackTop: { value: new THREE.Color(0x8fb0e0) },
        fallbackBottom: { value: new THREE.Color(0xd9dde3) }, has: { value: 0 } },
      vertexShader: /* glsl */ `
        out vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D gradient;
        uniform vec3 fallbackTop;
        uniform vec3 fallbackBottom;
        uniform float has;
        in vec3 vDir;
        layout(location = 0) out vec4 outColor;
        void main() {
          vec3 d = normalize(vDir);
          float e = asin(clamp(d.y, -1.0, 1.0));
          float t = clamp((e - (${LO.toFixed(4)})) / (${(HI - LO).toFixed(4)}), 0.0, 1.0);
          vec3 g = texture(gradient, vec2((t * ${BINS - 1}.0 + 0.5) / ${BINS}.0, 0.5)).rgb;
          // below the sampled range, fade to a light haze taken from mid-sky instead of extending the horizon bin
          vec3 haze = mix(texture(gradient, vec2(0.35, 0.5)).rgb, vec3(1.0), 0.25);
          g = mix(haze, g, smoothstep(-0.08, ${LO.toFixed(4)}, e));
          vec3 fb = mix(fallbackBottom, fallbackTop, smoothstep(-0.05, 0.6, d.y));
          outColor = vec4(mix(fb, g, has), 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }));
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  /** Add the clean sky pixels (well away from geometry) of a composited view image. */
  addView(spec: ViewSpec, image: Uint8ClampedArray, geometry: Uint8Array, size: number, margin = 48) {
    const cam = makeCamera(spec);
    const inv = cam.projectionMatrixInverse;
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    const dist = distanceTo(geometry, size, size);
    const v = new THREE.Vector3();
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const i = y * size + x;
        if (geometry[i] || dist[i] < margin) continue;
        v.set(((x + 0.5) / size) * 2 - 1, 1 - ((y + 0.5) / size) * 2, 0.5).applyMatrix4(inv).applyMatrix4(rot).normalize();
        const e = Math.asin(Math.max(-1, Math.min(1, v.y)));
        if (e < LO) continue;   // near the horizon models paint distant land, not sky
        const b = Math.round(((e - LO) / (HI - LO)) * (BINS - 1));
        if (b >= BINS) continue;
        this.sum[3 * b] += image[4 * i];
        this.sum[3 * b + 1] += image[4 * i + 1];
        this.sum[3 * b + 2] += image[4 * i + 2];
        this.count[b]++;
      }
    }
  }

  /** Average the bins, fill empty ones from their neighbours, upload, and write the equirect export. */
  finish() {
    const col: (number[] | null)[] = Array.from({ length: BINS }, (_, b) =>
      this.count[b] > 50 ? [0, 1, 2].map((c) => this.sum[3 * b + c] / this.count[b]) : null);
    const known = col.map((c, b) => (c ? b : -1)).filter((b) => b >= 0);
    if (!known.length) return;
    for (let b = 0; b < BINS; b++) {
      if (col[b]) continue;
      const lo = known.filter((k) => k < b).pop();
      const hi = known.find((k) => k > b);
      if (lo === undefined) col[b] = col[hi!]!.slice();
      else if (hi === undefined) col[b] = col[lo]!.slice();
      else { const t = (b - lo) / (hi - lo); col[b] = col[lo]!.map((c, i) => c + (col[hi]![i] - c) * t); }
    }
    // light smoothing so neighbouring bins blend
    const sm = col.map((_, b) => [0, 1, 2].map((c) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, b - 2); k <= Math.min(BINS - 1, b + 2); k++) { s += col[k]![c]; n++; }
      return s / n;
    }));
    const g = this.gradient.image.data as Uint8Array;
    for (let b = 0; b < BINS; b++) { g[4 * b] = sm[b][0]; g[4 * b + 1] = sm[b][1]; g[4 * b + 2] = sm[b][2]; g[4 * b + 3] = 255; }
    this.gradient.needsUpdate = true;
    for (let y = 0; y < this.height; y++) {
      const e = Math.PI / 2 - (y / (this.height - 1)) * Math.PI;
      const t = Math.max(0, Math.min(1, (e - LO) / (HI - LO))) * (BINS - 1);
      const b0 = Math.floor(t), b1 = Math.min(BINS - 1, b0 + 1), f = t - b0;
      const c = [0, 1, 2].map((k) => sm[b0][k] + (sm[b1][k] - sm[b0][k]) * f);
      for (let x = 0; x < this.width; x++) {
        const j = 4 * (y * this.width + x);
        this.data[j] = c[0]; this.data[j + 1] = c[1]; this.data[j + 2] = c[2]; this.data[j + 3] = 255;
      }
    }
    (this.mesh.material as THREE.ShaderMaterial).uniforms.has.value = 1;
    this.built = true;
  }

  /** Whether `finish` has built a gradient from painted views. */
  built = false;

  reset() {
    this.built = false;
    this.sum.fill(0);
    this.count.fill(0);
    (this.mesh.material as THREE.ShaderMaterial).uniforms.has.value = 0;
  }
}

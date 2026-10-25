import * as THREE from 'three';

/** Shared WebGL2 renderer plus helpers for full-screen passes and render-target readback. */
export class Gpu {
  readonly renderer: THREE.WebGLRenderer;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true,
      powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Draw a full-screen shader into `target` (null = canvas). Clears first unless `clear` is false. */
  pass(material: THREE.Material, target: THREE.WebGLRenderTarget | null, clear = true) {
    const r = this.renderer;
    this.quad.material = material;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.autoClear;
    r.autoClear = clear;
    r.setRenderTarget(target);
    r.render(this.quadScene, this.quadCam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevClear;
  }

  /** Render a scene into a target with an optional clear colour. */
  draw(scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, clear: THREE.ColorRepresentation | null = 0x000000, clearAlpha = 0) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(target);
    if (clear !== null) {
      r.setClearColor(clear, clearAlpha);
      r.clear(true, true, true);
    }
    r.autoClear = false;
    r.render(scene, camera);
    r.autoClear = prevClear;
    r.setClearColor(prevColor, prevAlpha);
    r.setRenderTarget(prevTarget);
  }

  /** RGBA8 readback. Rows come back bottom-up (GL order); `topDown` flips them to image order. */
  readU8(rt: THREE.WebGLRenderTarget, index = 0, topDown = true): Uint8ClampedArray {
    const { width: w, height: h } = rt;
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf, undefined, index);
    return new Uint8ClampedArray(topDown ? flipRows(buf, w, h, 4).buffer : buf.buffer);
  }

  readF32(rt: THREE.WebGLRenderTarget, index = 0, topDown = true): Float32Array {
    const { width: w, height: h } = rt;
    const buf = new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf, undefined, index);
    return topDown ? flipRows(buf, w, h, 4) : buf;
  }
}

export function flipRows<T extends Uint8Array | Float32Array>(src: T, w: number, h: number, ch: number): T {
  const out = new (src.constructor as { new(n: number): T })(src.length);
  const row = w * ch;
  for (let y = 0; y < h; y++) out.set(src.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

export function floatTarget(w: number, h: number, opts: { count?: number; half?: boolean; linear?: boolean; depth?: boolean } = {}) {
  const filter = opts.linear ? THREE.LinearFilter : THREE.NearestFilter;
  return new THREE.WebGLRenderTarget(w, h, {
    count: opts.count ?? 1,
    type: opts.half ? THREE.HalfFloatType : THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: opts.depth ?? false,
    generateMipmaps: false,
  });
}

export function byteTarget(w: number, h: number, opts: { count?: number; depth?: boolean; linear?: boolean } = {}) {
  const filter = opts.linear === false ? THREE.NearestFilter : THREE.LinearFilter;
  return new THREE.WebGLRenderTarget(w, h, {
    count: opts.count ?? 1,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: opts.depth ?? false,
    generateMipmaps: false,
  });
}

export const FULLSCREEN_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** A ShaderMaterial for full-screen passes (GLSL3; declare your own `out` variables). */
export function passMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

import * as THREE from 'three';
import { byteTarget, floatTarget, passMaterial, type Gpu } from './gpu';
import type { Level } from './scene';

/** Lighting for the gray "clay" renders the image models see. Directions are in world space (Y up). */
export interface Lighting {
  /** Preset name, kept with saved runs so a top-up paints in the same light. */
  name?: string;
  /** Sun azimuth in degrees (0 = sun to the +Z side, 90 = +X side) and elevation above the horizon. */
  sunAzimuth: number;
  sunElevation: number;
  sunIntensity: number;
  skyIntensity: number;
  /** Fill from the side opposite the sun, standing in for bounce light (share of sun intensity). */
  bounce: number;
  exposure: number;
  /** Background colour (sky) in linear RGB. */
  sky: [number, number, number];
  /**
   * Paint under soft overcast light: the sun casts no shadows and only shapes the faces a little. The models then
   * paint near-albedo textures, and shadows come from real lighting at display time instead of being baked in.
   */
  overcast?: boolean;
}

export const OUTDOOR: Lighting = { name: 'outdoor', sunAzimuth: 45, sunElevation: 50, sunIntensity: 2.7, skyIntensity: 2.1, bounce: 0.35,
  exposure: 1.0, sky: [0.36, 0.55, 0.86] };
export const OVERCAST: Lighting = { name: 'overcast', sunAzimuth: 45, sunElevation: 65, sunIntensity: 0.9, skyIntensity: 3.1, bounce: 0.2,
  exposure: 1.0, sky: [0.62, 0.68, 0.78], overcast: true };
export const INDOOR: Lighting = { name: 'indoor', sunAzimuth: 200, sunElevation: 35, sunIntensity: 4.5, skyIntensity: 1.6, bounce: 0.45,
  exposure: 1.2, sky: [0.5, 0.6, 0.75] };

export function sunDirection(l: Lighting): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(l.sunAzimuth);
  const el = THREE.MathUtils.degToRad(l.sunElevation);
  // direction the light travels (from the sun into the scene)
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/** Screen-space ambient occlusion from the view's world-position/normal buffers. */
const AO_FRAG = /* glsl */ `
uniform sampler2D gPos;
uniform sampler2D gNrm;
uniform mat4 viewProj;
uniform vec3 camPos;
uniform float radius;
uniform vec3 kernel[16];
in vec2 vUv;
layout(location = 0) out vec4 outAO;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 P = texture(gPos, vUv);
  vec4 N = texture(gNrm, vUv);
  if (N.a < 0.5) { outAO = vec4(1.0); return; }
  vec3 n = normalize(N.xyz);
  float a = hash(gl_FragCoord.xy) * 6.2831853;
  vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  vec3 tr = t * cos(a) + b * sin(a);
  vec3 br = cross(n, tr);
  float occ = 0.0;
  for (int i = 0; i < 16; i++) {
    vec3 k = kernel[i];
    vec3 s = P.xyz + (tr * k.x + br * k.y + n * k.z) * radius;
    vec4 c = viewProj * vec4(s, 1.0);
    if (c.w <= 0.0) continue;
    vec2 suv = c.xy / c.w * 0.5 + 0.5;
    if (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) continue;
    vec4 q = texture(gPos, suv);
    if (q.w > 0.0 && q.w < length(s - camPos) - 0.03) {
      occ += smoothstep(0.0, 1.0, radius / max(length(q.xyz - P.xyz), 1e-3));
    }
  }
  float ao = clamp(1.0 - occ / 16.0, 0.0, 1.0);
  outAO = vec4(ao, ao, ao, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D src;
uniform vec2 texel;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  float s = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) s += texture(src, vUv + vec2(x, y) * texel).r;
  outColor = vec4(vec3(s / 25.0), 1.0);
}`;

const OUTPUT_FRAG = /* glsl */ `
#include <tonemapping_pars_fragment>
uniform sampler2D src;
uniform sampler2D ao;
uniform float aoStrength;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 c = texture(src, vUv).rgb * mix(1.0, texture(ao, vUv).r, aoStrength);
  c = NeutralToneMapping(c);
  outColor = vec4(sRGBTransferOETF(vec4(c, 1.0)).rgb, 1.0);
}`;

function aoKernel(): THREE.Vector3[] {
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 16 }, (_, i) => {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd()).normalize();
    const s = i / 16;
    return v.multiplyScalar(0.15 + 0.85 * s * s);
  });
}

/** Renders the level as lit clay (sun + sky + bounce + shadows + AO), tone-mapped to sRGB 8-bit. */
export class ClayRenderer {
  readonly scene = new THREE.Scene();
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly sun = new THREE.DirectionalLight(0xfff4e6, 3);
  private readonly fill = new THREE.DirectionalLight(0xdfe6f0, 1);
  private readonly hemi = new THREE.HemisphereLight(0xc4d6f2, 0xa09e9a, 1);
  private hdr: THREE.WebGLRenderTarget;
  private aoRaw: THREE.WebGLRenderTarget;
  private aoBlur: THREE.WebGLRenderTarget;
  private readonly skyColor = new THREE.Color();
  private readonly output: THREE.ShaderMaterial;
  private readonly aoMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  lighting: Lighting;

  constructor(private readonly gpu: Gpu, private readonly level: Level, lighting: Lighting = OUTDOOR, size = 1024) {
    this.material = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(level.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh, this.sun, this.sun.target, this.fill, this.fill.target, this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2;
    this.hdr = this.makeHdr(size);
    this.aoRaw = byteTarget(size, size);
    this.aoBlur = byteTarget(size, size);
    this.output = passMaterial(OUTPUT_FRAG, { src: { value: null }, ao: { value: null }, aoStrength: { value: 0.85 },
      toneMappingExposure: { value: 1 } });
    this.aoMat = passMaterial(AO_FRAG, { gPos: { value: null }, gNrm: { value: null }, viewProj: { value: new THREE.Matrix4() },
      camPos: { value: new THREE.Vector3() }, radius: { value: 0.9 }, kernel: { value: aoKernel() } });
    this.blurMat = passMaterial(BLUR_FRAG, { src: { value: null }, texel: { value: new THREE.Vector2(1 / size, 1 / size) } });
    this.lighting = lighting;
    this.setLighting(lighting);
  }

  private makeHdr(size: number) {
    const t = floatTarget(size, size, { half: true, depth: true, linear: true });
    t.samples = 4;
    return t;
  }

  setLighting(l: Lighting) {
    this.lighting = l;
    const sphere = this.level.geometry.boundingSphere!;
    const dir = sunDirection(l);
    this.sun.intensity = l.sunIntensity;
    this.sun.position.copy(sphere.center).addScaledVector(dir, -sphere.radius * 2);
    this.sun.target.position.copy(sphere.center);
    const fillDir = new THREE.Vector3(-dir.x, Math.min(-0.2, dir.y * 0.3), -dir.z).normalize();
    this.fill.intensity = l.sunIntensity * l.bounce;
    this.fill.position.copy(sphere.center).addScaledVector(fillDir, -sphere.radius * 2);
    this.fill.target.position.copy(sphere.center);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -sphere.radius;
    cam.right = cam.top = sphere.radius;
    cam.near = 0.1;
    cam.far = sphere.radius * 4;
    cam.updateProjectionMatrix();
    this.sun.castShadow = !l.overcast;
    this.sun.shadow.needsUpdate = true;
    this.hemi.intensity = l.skyIntensity;
    this.skyColor.setRGB(...l.sky);
    this.output.uniforms.toneMappingExposure.value = l.exposure;
  }

  /**
   * Render the clay view for `camera` into an sRGB byte target. `gbuf` (world position + distance, normal) from
   * the same camera enables ambient occlusion.
   */
  render(camera: THREE.Camera, out: THREE.WebGLRenderTarget, gbuf?: { pos: THREE.Texture; nrm: THREE.Texture }) {
    if (this.hdr.width !== out.width) {
      for (const t of [this.hdr, this.aoRaw, this.aoBlur]) t.dispose();
      this.hdr = this.makeHdr(out.width);
      this.aoRaw = byteTarget(out.width, out.height);
      this.aoBlur = byteTarget(out.width, out.height);
      this.blurMat.uniforms.texel.value.set(1 / out.width, 1 / out.height);
    }
    this.gpu.renderer.toneMappingExposure = this.lighting.exposure;
    this.gpu.draw(this.scene, camera, this.hdr, this.skyColor, 1);
    if (gbuf) {
      const u = this.aoMat.uniforms;
      u.gPos.value = gbuf.pos;
      u.gNrm.value = gbuf.nrm;
      u.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
      this.gpu.pass(this.aoMat, this.aoRaw);
      this.blurMat.uniforms.src.value = this.aoRaw.texture;
      this.gpu.pass(this.blurMat, this.aoBlur);
    } else {
      this.gpu.draw(new THREE.Scene(), camera, this.aoBlur, 0xffffff, 1);
    }
    this.output.uniforms.src.value = this.hdr.texture;
    this.output.uniforms.ao.value = this.aoBlur.texture;
    this.gpu.pass(this.output, out);
  }

  makeTarget(size: number) {
    return byteTarget(size, size, { linear: false });
  }
}

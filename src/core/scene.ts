import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

/** A level flattened into one world-space mesh with a single UV set (TEXCOORD_0). */
export interface Level {
  name: string;
  /** Part names from the file (glTF material, else mesh name); the `label` vertex attribute indexes this. */
  labels: string[];
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
  bounds: THREE.Box3;
  triangles: number;
  surfaceArea: number;
}

export async function loadLevel(source: string | ArrayBuffer, name = 'level'): Promise<Level> {
  const loader = new GLTFLoader();
  const gltf = typeof source === 'string'
    ? await loader.loadAsync(source)
    : await loader.parseAsync(source, '');
  gltf.scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const labels: string[] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const label = partName(mesh);
    if (!labels.includes(label)) labels.push(label);
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!g.getAttribute('uv')) throw new Error(`mesh "${mesh.name}" has no UVs; unwrap the level first`);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'label') g.deleteAttribute(k);
    }
    g.morphAttributes = {};
    g.setAttribute('label', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(labels.indexOf(label)), 1));
    parts.push(g);
  });
  if (!parts.length) throw new Error('no meshes in the file');
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!geometry) throw new Error('could not merge meshes');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bvh = new MeshBVH(geometry);
  const pos = geometry.getAttribute('position');
  const tri = new THREE.Triangle();
  let area = 0;
  const triangles = (geometry.index ? geometry.index.count : pos.count) / 3;
  const idx = geometry.index;
  for (let t = 0; t < triangles; t++) {
    const a = idx ? idx.getX(3 * t) : 3 * t;
    const b = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    tri.setFromAttributeAndIndices(pos, a, b, c);
    area += tri.getArea();
  }
  return { name, labels, geometry, bvh, bounds: geometry.boundingBox!.clone(), triangles, surfaceArea: area };
}

/** A readable part name: material name if it isn't a default, else the mesh name, without numeric suffixes. */
function partName(mesh: THREE.Mesh): string {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const raw = (mat?.name && !/^(material|default|clay)?[._ -]?\d*$/i.test(mat.name) ? mat.name : mesh.name) || 'surface';
  return raw.replace(/[._-]\d+$/, '').replace(/[_-]+/g, ' ').trim().toLowerCase() || 'surface';
}

/** Iterate triangles as (a, b, c, normal, area) in world space. */
export function forEachTriangle(level: Level, fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  n: THREE.Vector3, area: number) => void) {
  const g = level.geometry;
  const pos = g.getAttribute('position');
  const idx = g.index;
  const count = (idx ? idx.count : pos.count) / 3;
  const tri = new THREE.Triangle();
  const n = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    const a = idx ? idx.getX(3 * t) : 3 * t;
    const b = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    tri.setFromAttributeAndIndices(pos, a, b, c);
    tri.getNormal(n);
    fn(tri.a, tri.b, tri.c, n, tri.getArea());
  }
}

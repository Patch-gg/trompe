"""Build a blockout level, render lit-clay views + data passes, and bake texel maps.

Run: blender -b -P blender/scenes.py -- <exterior|interior> <out_dir>

Writes to <out_dir>/<scene>/:
  views.json                      camera intrinsics/extrinsics per view
  view_<name>_beauty.png          lit clay render (Cycles, AgX) fed to the image models
  view_<name>_pos.npy             float32 HxWx4 world position + coverage alpha
  view_<name>_nrm.npy             float16 HxWx3 world geometric normal
  view_<name>_uv.npy              float32 HxWx2 UV of the visible surface
  texel_pos.npy / texel_nrm.npy   float32/float16 TxTx3 world position/normal per texel
  texel_cov.npy                   bool TxT, True where a UV island covers the texel
  level.glb, level.blend          the blockout itself
"""
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

RES = 1024
TEX = 4096
EYE = 1.7


# ---------------------------------------------------------------- geometry

def add_box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    m = Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


def add_cyl(bm, x, y, z0, h, r, segments=24):
    m = Matrix.Translation((x, y, z0 + h / 2))
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=r, radius2=r, depth=h, matrix=m)


def exterior(bm):
    add_box(bm, -16, 26, -16, 16, -0.2, 0)                 # ground
    add_box(bm, -12, 12, 10, 16, 0, 9)                     # north building
    add_box(bm, -2, 2, 9.0, 10, 0, 4)                      # entrance block
    add_box(bm, 6, 9, 10.5, 13, 9, 13)                     # tower on north roof
    add_box(bm, -12, 2, -16, -10, 0, 7)                    # south building (low)
    add_box(bm, 2, 12, -16, -10, 0, 10)                    # south building (tall)
    add_box(bm, -16, -10, -10, 10, 0, 8)                   # west building
    add_box(bm, -10, -9, -3, 3, 3.2, 3.4)                  # west balcony slab
    add_box(bm, -9.1, -9.0, -3, 3, 3.4, 4.4)               # balcony railing
    add_box(bm, 10, 11, -10, -2, 0, 6)                     # east wall, south part
    add_box(bm, 10, 11, 2, 10, 0, 6)                       # east wall, north part
    add_box(bm, 10, 11, -2, 2, 4, 6)                       # lintel over the gateway
    add_box(bm, 18, 24, -8, 8, 0, 7)                       # building beyond the gate
    for i, h in enumerate((0.6, 0.4, 0.2)):                # stairs up to the entrance
        y1 = 9.0 - 0.6 * i
        add_box(bm, -2.5, 2.5, y1 - 0.6, y1, 0, h)
    add_box(bm, 3.5, 4.5, -4.5, -3.5, 0, 1)                # crates
    add_box(bm, 4.6, 5.6, -4.6, -3.6, 0, 1)
    add_box(bm, 4.0, 5.0, -4.5, -3.5, 1, 2)
    add_box(bm, -8.6, -8.2, -7, -3, 0, 0.5)                # low bench along the west building
    add_cyl(bm, 0, 0, 0, 0.6, 1.5, 32)                     # fountain basin
    add_cyl(bm, 0, 0, 0.6, 1.0, 0.3, 16)                   # fountain pillar
    add_box(bm, -8.4, -7.6, 7.6, 8.4, 0, 4.5)              # pillar
    add_cyl(bm, 7, 6, 0, 1.0, 0.4, 20)                     # barrel


def interior(bm):
    add_box(bm, -10.3, 10.3, -5.3, 5.3, -0.2, 0)           # floor
    add_box(bm, -10.3, 10.3, -5.3, 5.3, 6.0, 6.3)          # ceiling slab
    # north wall (y 5..5.3) with four windows (x centres -6,-2,2,6, width 2, z 2..4)
    add_box(bm, -10, 10, 5, 5.3, 0, 2)
    add_box(bm, -10, 10, 5, 5.3, 4, 6)
    for x0, x1 in ((-10, -7), (-5, -3), (-1, 1), (3, 5), (7, 10)):
        add_box(bm, x0, x1, 5, 5.3, 2, 4)
    # south wall with a doorway (x -1..1, z 0..3)
    add_box(bm, -10, -1, -5.3, -5, 0, 6)
    add_box(bm, 1, 10, -5.3, -5, 0, 6)
    add_box(bm, -1, 1, -5.3, -5, 3, 6)
    add_box(bm, -10.3, -10, -5.3, 5.3, 0, 6)               # west wall
    add_box(bm, 10, 10.3, -5.3, 5.3, 0, 6)                 # east wall
    for x in (-5, 0, 5):
        for y in (-2, 2):
            add_box(bm, x - 0.3, x + 0.3, y - 0.3, y + 0.3, 0, 5.4)   # pillars
        add_box(bm, x - 0.25, x + 0.25, -5, 5, 5.4, 6)               # ceiling beams
    add_box(bm, -9.0, -7.8, -3.9, -2.7, 0, 1.2)            # crate stack
    add_box(bm, -7.7, -6.5, -3.9, -2.7, 0, 1.2)
    add_box(bm, -8.4, -7.2, -3.9, -2.7, 1.2, 2.4)
    add_box(bm, 6.0, 8.0, -4.2, -2.7, 0, 1.8)              # machine block
    add_box(bm, -4.0, -2.0, 2.6, 3.6, 0.85, 0.95)          # table top
    for lx in (-3.9, -2.2):
        for ly in (2.7, 3.4):
            add_box(bm, lx, lx + 0.1, ly, ly + 0.1, 0, 0.85)
    add_box(bm, 6.5, 10, 2.5, 5, 2.8, 3.0)                 # mezzanine
    for i in range(5):                                     # stairs to the mezzanine
        x0 = 3.5 + 0.6 * i
        add_box(bm, x0, x0 + 0.6, 2.6, 3.8, 0, 0.56 * (i + 1))


# ---------------------------------------------------------------- views

def rotate_target(loc, target, degrees):
    d = Vector(target) - Vector(loc)
    d = Matrix.Rotation(math.radians(degrees), 3, 'Z') @ d
    return tuple(Vector(loc) + d)


EXT_A = (-6.0, -7.0, EYE)
EXT_TA = (2.0, 6.0, 3.0)
INT_A = (-8.5, -1.0, EYE)
INT_TA = (1.0, 3.0, 2.2)

VIEWS = {
    'exterior': [
        ('v1', EXT_A, EXT_TA),
        ('v2', EXT_A, rotate_target(EXT_A, EXT_TA, -55)),
        ('v3', (5.0, 2.5, EYE), (-6.0, 5.0, 3.0)),
        ('v4', (0.0, -9.0, EYE), (0.0, 6.0, 3.5)),          # held out for evaluation
    ],
    'interior': [
        ('v1', INT_A, INT_TA),
        ('v2', INT_A, rotate_target(INT_A, INT_TA, -55)),
        ('v3', (6.5, 0.8, EYE), (-6.0, -1.5, 2.0)),
        ('v4', (-2.5, -4.2, EYE), (-1.0, 4.0, 2.8)),        # held out for evaluation
    ],
}


# ---------------------------------------------------------------- scene setup

def node_tree(owner):
    if owner.node_tree is None:
        try:
            owner.use_nodes = True
        except AttributeError:
            pass
    return owner.node_tree


def emission_material(name, build):
    mat = bpy.data.materials.new(name)
    nt = node_tree(mat)
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    build(nt, em)
    return mat


def clay_material():
    mat = bpy.data.materials.new('clay')
    nt = node_tree(mat)
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0.72, 0.72, 0.72, 1)
    bsdf.inputs['Roughness'].default_value = 0.9
    return mat


def setup_cycles(scene):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'CUDA'          # OptiX fails under WSL
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'CUDA'
    scene.cycles.device = 'GPU'
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.use_persistent_data = True


def lights(scene, kind):
    world = bpy.data.worlds.new('world')
    scene.world = world
    bg = node_tree(world).nodes['Background']
    if kind == 'exterior':
        bg.inputs['Color'].default_value = (0.42, 0.58, 0.85, 1)
        bg.inputs['Strength'].default_value = 0.9
        sun_dir, energy = Vector((-0.55, 0.45, -0.70)), 4.5
    else:
        bg.inputs['Color'].default_value = (0.55, 0.65, 0.8, 1)
        bg.inputs['Strength'].default_value = 0.5
        sun_dir, energy = Vector((0.15, -0.80, -0.58)), 7.0
        for x in (-5.0, 5.0):
            ld = bpy.data.lights.new(f'area{x}', 'AREA')
            ld.shape, ld.size, ld.size_y = 'RECTANGLE', 0.6, 3.0
            ld.energy, ld.color = 220, (1.0, 0.92, 0.8)
            lo = bpy.data.objects.new(f'area{x}', ld)
            lo.location = (x, 0, 5.35)
            scene.collection.objects.link(lo)
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy, sd.angle = energy, math.radians(1.5)
    so = bpy.data.objects.new('sun', sd)
    so.rotation_euler = sun_dir.normalized().to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(so)
    return {'sun_direction': list(sun_dir.normalized()), 'sun_energy': energy}


def make_camera(scene, name, loc, target):
    cd = bpy.data.cameras.new(name)
    cd.lens_unit = 'FOV'
    cd.sensor_fit = 'HORIZONTAL'
    cd.angle = math.radians(90)
    cd.clip_start, cd.clip_end = 0.05, 300
    co = bpy.data.objects.new(name, cd)
    co.location = loc
    co.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(co)
    return co


def read_pixels(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = 'Non-Color'
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1].copy()


def render_to(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------- main

def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    kind, out_root = argv[0], argv[1]
    out = os.path.join(out_root, kind)
    os.makedirs(out, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    setup_cycles(scene)

    bm = bmesh.new()
    (exterior if kind == 'exterior' else interior)(bm)
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('level')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('level', mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(clay_material())
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002,
                             area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    light_info = lights(scene, kind)
    cams = [(n, make_camera(scene, n, loc, tgt)) for n, loc, tgt in VIEWS[kind]]

    # Lit clay beauty renders: what the image model sees.
    scene.view_settings.view_transform = 'AgX'
    scene.cycles.samples = 128
    scene.cycles.use_denoising = True
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    for name, cam in cams:
        scene.camera = cam
        render_to(scene, os.path.join(out, f'view_{name}_beauty.png'))

    # Data passes: unlit emission overrides, 1 sample, near-zero pixel filter.
    def pos_build(nt, em):
        g = nt.nodes.new('ShaderNodeNewGeometry')
        nt.links.new(g.outputs['Position'], em.inputs['Color'])

    def nrm_build(nt, em):
        g = nt.nodes.new('ShaderNodeNewGeometry')
        nt.links.new(g.outputs['True Normal'], em.inputs['Color'])

    def uv_build(nt, em):
        uv = nt.nodes.new('ShaderNodeUVMap')
        nt.links.new(uv.outputs['UV'], em.inputs['Color'])

    def one_build(nt, em):
        em.inputs['Color'].default_value = (1, 1, 1, 1)

    overrides = {k: emission_material(k, b) for k, b in
                 (('pos', pos_build), ('nrm', nrm_build), ('uv', uv_build), ('one', one_build))}
    scene.view_settings.view_transform = 'Standard'
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.cycles.filter_width = 0.01
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'OPEN_EXR'
    scene.render.image_settings.color_depth = '32'
    scene.render.image_settings.color_mode = 'RGBA'
    vl = bpy.context.view_layer
    views = []
    for name, cam in cams:
        scene.camera = cam
        passes = {}
        for k in ('pos', 'nrm', 'uv'):
            vl.material_override = overrides[k]
            p = os.path.join(out, f'_tmp_{name}_{k}.exr')
            render_to(scene, p)
            passes[k] = read_pixels(p)
            os.remove(p)
        np.save(os.path.join(out, f'view_{name}_pos.npy'), passes['pos'])
        np.save(os.path.join(out, f'view_{name}_nrm.npy'), passes['nrm'][..., :3].astype(np.float16))
        np.save(os.path.join(out, f'view_{name}_uv.npy'), passes['uv'][..., :2])
        views.append({'name': name, 'matrix_world': [list(r) for r in cam.matrix_world],
                      'fov_deg': 90.0, 'width': RES, 'height': RES,
                      'location': list(cam.location)})
    vl.material_override = None

    # Texel maps: bake world position / normal / coverage into the UV atlas.
    # Persistent render data leaves the first bakes empty, and each bake needs its own image.
    scene.render.use_persistent_data = False
    scene.cycles.samples = 1
    texel = {}
    for k in ('pos', 'nrm', 'one'):
        bake_img = bpy.data.images.new(f'bake_{k}', TEX, TEX, alpha=True, float_buffer=True)
        bake_img.colorspace_settings.name = 'Non-Color'
        mat = overrides[k]
        nt = mat.node_tree
        tex_node = nt.nodes.new('ShaderNodeTexImage')
        tex_node.image = bake_img
        nt.nodes.active = tex_node
        obj.data.materials[0] = mat
        bpy.ops.object.bake(type='EMIT', margin=0, use_clear=True)
        a = np.empty(TEX * TEX * 4, dtype=np.float32)
        bake_img.pixels.foreach_get(a)
        texel[k] = a.reshape(TEX, TEX, 4)[::-1].copy()
    np.save(os.path.join(out, 'texel_pos.npy'), texel['pos'][..., :3])
    np.save(os.path.join(out, 'texel_nrm.npy'), texel['nrm'][..., :3].astype(np.float16))
    np.save(os.path.join(out, 'texel_cov.npy'), texel['one'][..., 0] > 0.5)
    obj.data.materials[0] = bpy.data.materials['clay']

    with open(os.path.join(out, 'views.json'), 'w') as f:
        json.dump({'scene': kind, 'texture_size': TEX, 'eye_height': EYE,
                   'lights': light_info, 'views': views}, f, indent=1)
    try:
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'level.glb'), export_format='GLB')
    except Exception as e:  # the exporter is a bundled add-on; a missing one shouldn't sink the spike
        print('glTF export failed:', e)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'level.blend'))
    print('DONE', kind, 'coverage texels:', int((texel['one'][..., 0] > 0.5).sum()))


main()

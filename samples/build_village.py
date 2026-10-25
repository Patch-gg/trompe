"""Build the demo blockout: a small village (plaza, two alleys, archways, arcade terrace, bell tower).

Run: blender -b --factory-startup -P samples/build_village.py -- samples/village.glb
Untextured boxes only; Smart UV Project UVs; bottom faces removed so UV space goes to visible surfaces.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector


def box(bm, x0, x1, y0, y1, z0, z1):
    c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(c) @ Matrix.Diagonal((x1 - x0, y1 - y0, z1 - z0, 1)))


def cyl(bm, x, y, z0, h, r, seg=24):
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=h,
                          matrix=Matrix.Translation((x, y, z0 + h / 2)))


def gable(bm, x0, x1, y0, y1, z0, h, ridge='x'):
    """Triangular-prism roof on top of a box; ridge runs along x or y."""
    if ridge == 'x':
        ym = (y0 + y1) / 2
        pts = [(x0, y0, z0), (x0, y1, z0), (x0, ym, z0 + h), (x1, y0, z0), (x1, y1, z0), (x1, ym, z0 + h)]
    else:
        xm = (x0 + x1) / 2
        pts = [(x0, y0, z0), (x1, y0, z0), (xm, y0, z0 + h), (x0, y1, z0), (x1, y1, z0), (xm, y1, z0 + h)]
    v = [bm.verts.new(p) for p in pts]
    # the two triangular ends, the two slopes, the underside
    return [bm.faces.new([v[i] for i in f]) for f in ((0, 2, 1), (3, 4, 5), (0, 3, 5, 2), (1, 2, 5, 4), (0, 1, 4, 3))]


LABELS = []


class tagged:
    """Label every face created inside the block; labels become glTF materials the texturing prompts can name."""

    def __init__(self, bm, name):
        self.bm, self.name = bm, name

    def __enter__(self):
        label_index(self.name)
        self.bm.faces.ensure_lookup_table()
        self.start = len(self.bm.faces)
        return self

    def __exit__(self, *exc):
        self.bm.faces.ensure_lookup_table()
        for i in range(self.start, len(self.bm.faces)):
            self.bm.faces[i].material_index = LABELS.index(self.name)


def label_index(name):
    if name not in LABELS:
        LABELS.append(name)
    return LABELS.index(name)


def gable_roof(bm, wall_label, *args):
    """A gable roof whose slopes are roof, whose triangular ends belong to the walls below, and whose underside is eaves."""
    with tagged(bm, 'tiled roof'):
        faces = gable(bm, *args)
    for f in faces[:2]:
        f.material_index = label_index(wall_label)
    faces[4].material_index = label_index('eaves')


def house(bm, x0, x1, y0, y1, h, roof=None, ridge='x', overhang=0.4, label='house walls'):
    with tagged(bm, label):
        box(bm, x0, x1, y0, y1, 0, h)
    if roof:
        gable_roof(bm, label, x0 - overhang, x1 + overhang, y0 - overhang, y1 + overhang, h, roof, ridge)


def village(bm):
    with tagged(bm, 'cobblestone ground'):         # walkable ground: plaza and both alleys
        box(bm, -13, 13, -11, 11, -0.3, 0)
        box(bm, -13, -7, 11, 31, -0.3, 0)
        box(bm, 13, 31, -2.5, 2.5, -0.3, 0)
    house(bm, -21, -13, -11, 11, 8.5, roof=2.6, ridge='y')   # west side
    with tagged(bm, 'balcony'):
        box(bm, -13, -12, -3, 3, 3.4, 3.6)
        box(bm, -12.1, -12, -3, 3, 3.6, 4.6)
    house(bm, -7, 3, 11, 18, 10, roof=2.4, ridge='x', label='church walls')   # north row
    house(bm, 3, 13, 11, 18, 8, roof=2.2, ridge='x')
    with tagged(bm, 'bell tower'):
        box(bm, 0, 3.5, 11.5, 15, 10, 19)
    gable_roof(bm, 'bell tower', -0.3, 3.8, 11.2, 15.3, 19, 2.2, 'x')
    with tagged(bm, 'church porch'):
        box(bm, -2.2, 2.2, 10.2, 11, 0, 3.6)
    with tagged(bm, 'stone steps'):
        for i, hgt in enumerate((0.45, 0.3, 0.15)):
            box(bm, -2.6, 2.6, 9.4 - 0.4 * i + 0.4, 9.4 - 0.4 * i + 0.8, 0, hgt)
    house(bm, -21, -13, 11, 31, 9, roof=2.4, ridge='y')      # alley A walls
    house(bm, -7, 1, 18, 31, 7.5, roof=2.0, ridge='y')
    with tagged(bm, 'stone archway'):
        box(bm, -13, -7, 21, 22.2, 4.2, 6.2)
    with tagged(bm, 'stone stairs'):
        for i in range(6):
            y0 = 24 + 0.7 * i
            box(bm, -13, -7, y0, 31, 0, 0.32 * (i + 1))
    house(bm, 13, 21, 2.5, 11, 9, roof=2.4, ridge='y')       # east side, alley B between the blocks
    house(bm, 13, 21, -11, -2.5, 6.5, roof=2.0, ridge='y')
    with tagged(bm, 'stone archway'):
        box(bm, 13, 14.5, -2.5, 2.5, 4.4, 6.3)
    house(bm, 21, 31, 2.5, 9, 7.5, roof=2.0, ridge='x')
    house(bm, 21, 31, -9, -2.5, 8.5, roof=2.2, ridge='x')
    with tagged(bm, 'house walls'):
        box(bm, 31, 34, -4, 4, 0, 6)
    with tagged(bm, 'raised stone terrace'):                  # south: arcade terrace
        box(bm, -13, 1, -18, -11, 0, 1.2)
    with tagged(bm, 'stone steps'):
        for i in range(3):
            box(bm, -9, -3, -11 + 0.45 * i, -10.55 + 0.45 * i, 0, 0.4 * (i + 1))
    with tagged(bm, 'stone arcade columns'):
        for x in (-12, -8.5, -5, -1.5):
            box(bm, x - 0.3, x + 0.3, -12.1, -11.5, 1.2, 4.8)
    with tagged(bm, 'arcade roof'):
        box(bm, -13, 1, -12.4, -11.2, 4.8, 5.6)
        box(bm, -13, 1, -18, -12.4, 4.8, 5.2)
    house(bm, -21, 1, -26, -18, 9.5, roof=2.6, ridge='x')
    house(bm, 1, 13, -24, -11, 7, roof=2.2, ridge='x')
    with tagged(bm, 'door porch'):
        box(bm, 4, 7, -11, -9.8, 0, 3.2)
    with tagged(bm, 'stone fountain'):                        # plaza props
        cyl(bm, 0, 0, 0, 0.7, 2.2, 40)
        cyl(bm, 0, 0, 0.7, 2.1, 0.35, 16)
        cyl(bm, 0, 0, 2.8, 0.35, 0.9, 24)
    with tagged(bm, 'wooden market stall'):
        box(bm, 6, 8.2, 3.5, 4.5, 0, 0.9)
        for px in (6.05, 8.15):
            for py in (3.55, 4.95):
                box(bm, px - 0.05, px + 0.05, py - 0.05, py + 0.05, 0, 2.4)
        box(bm, 5.7, 8.5, 3.2, 5.3, 2.4, 2.55)
    with tagged(bm, 'wooden crates'):
        for x, y, z in ((9.5, -6, 0), (10.6, -6.2, 0), (10.0, -6.1, 1)):
            box(bm, x - 0.5, x + 0.5, y - 0.5, y + 0.5, z, z + 1)
        box(bm, 16, 18, -2.4, -1.4, 0, 0.9)
        box(bm, -12.5, -11.5, 15, 16, 0, 1.0)
    with tagged(bm, 'wooden barrels'):
        for x, y in ((-9.5, 6.5), (-10.4, 7.3), (11, 7.5)):
            cyl(bm, x, y, 0, 1.0, 0.42, 18)
    with tagged(bm, 'stone benches'):
        box(bm, -5, -2, 7.6, 8.1, 0, 0.5)
        box(bm, 2, 5, -7.6, -7.1, 0, 0.5)


PLAY = [(-13, 13, -11, 11), (-13, -7, 11, 31), (13, 31, -2.5, 2.5), (-13, 1, -18, -11)]   # x0, x1, y0, y1


def in_play(x, y, pad=0.0):
    return any(x0 - pad <= x <= x1 + pad and y0 - pad <= y <= y1 + pad for x0, x1, y0, y1 in PLAY)


def importance(f):
    """Texture-space share for a face: surfaces players walk past get the most, roofs less, outer walls least."""
    c, n = f.calc_center_median(), f.normal
    if n.z > 0.3 and c.z > 4.0:
        return 'roof'
    if n.z > 0.7:
        return 'play' if in_play(c.x, c.y, 0.5) else 'outer'
    if in_play(c.x, c.y, 0.6) or in_play(c.x + n.x * 1.5, c.y + n.y * 1.5):
        return 'play'
    return 'outer'


SCALE = {'play': 1.0, 'roof': 0.5, 'outer': 0.3}


def unwrap_by_importance(obj):
    """Smart UV project each importance group on its own, shrink the less important ones, then pack together."""
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bm = bmesh.from_edit_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    groups = {}
    for f in bm.faces:
        groups.setdefault(importance(f), []).append(f.index)
    for name, idx in groups.items():
        for f in bm.faces:
            f.select_set(False)
        for i in idx:
            bm.faces[i].select_set(True)
        bmesh.update_edit_mesh(obj.data)
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bm = bmesh.from_edit_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        uv = bm.loops.layers.uv.active
        for i in idx:
            for loop in bm.faces[i].loops:
                loop[uv].uv *= SCALE[name]
        bmesh.update_edit_mesh(obj.data)
    for f in bm.faces:
        f.select_set(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.002)
    bm = bmesh.from_edit_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    share = {}
    for f in bm.faces:
        pts = [l[uv].uv for l in f.loops]
        a = 0.0
        for k in range(1, len(pts) - 1):
            a += abs((pts[k].x - pts[0].x) * (pts[k + 1].y - pts[0].y) - (pts[k + 1].x - pts[0].x) * (pts[k].y - pts[0].y)) / 2
        share[importance(f)] = share.get(importance(f), 0.0) + a
    bpy.ops.object.mode_set(mode='OBJECT')
    print('UV share by group:', {k: round(v, 3) for k, v in share.items()}, 'faces:', {k: len(v) for k, v in groups.items()})


def main():
    out = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    village(bm)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    # drop downward faces resting on the ground: never visible, they'd only waste texture space
    drop = [f for f in bm.faces if f.normal.z < -0.99 and f.calc_center_median().z < 0.05]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    for f in bm.faces:
        f.smooth = False
    mesh = bpy.data.meshes.new('village')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('village', mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for name in LABELS:
        obj.data.materials.append(bpy.data.materials.new(name))
    unwrap_by_importance(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True)
    print('DONE', out, len(mesh.polygons), 'faces', round(sum(p.area for p in mesh.polygons)), 'm2')


main()

"""Camera math, texel visibility, state images and projection for the spike.

Conventions: images are row-major top-down (row = v, col = u); pixel (r, c) has its centre at
(c + 0.5, r + 0.5). Texel maps are T x T, top-down, texel (y, x) <-> UV ((x + .5) / T, 1 - (y + .5) / T).
"""
import json
import os
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


@dataclass
class View:
    name: str
    C: np.ndarray          # camera centre (3,)
    R: np.ndarray          # world -> camera rotation (3, 3); camera looks down -Z, +Y up
    f: float               # focal length in pixels
    W: int
    H: int
    beauty: np.ndarray     # HxWx3 uint8 lit clay render
    pos: np.ndarray        # HxWx3 float32 world position of the visible surface
    alpha: np.ndarray      # HxW bool, True where geometry (False = sky)
    nrm: np.ndarray        # HxWx3 float32 world normal
    uv: np.ndarray         # HxWx2 float32

    def project(self, P):
        pc = (P - self.C) @ self.R.T
        z = -pc[:, 2]
        with np.errstate(divide='ignore', invalid='ignore'):
            u = self.W / 2 + self.f * pc[:, 0] / z
            v = self.H / 2 - self.f * pc[:, 1] / z
        return u, v, z


@dataclass
class Scene:
    name: str
    T: int
    views: dict
    cov: np.ndarray        # TxT bool
    idx: np.ndarray        # flat texel indices covered by UV islands (N,)
    P: np.ndarray          # (N, 3) float32 texel world positions
    Nrm: np.ndarray        # (N, 3) float32 texel world normals
    pad: np.ndarray        # TxT int32: flat index of the nearest covered texel (UV edge padding)
    vis: dict              # view name -> visibility table


def load_scene(name):
    d = os.path.join(OUT, name)
    meta = json.load(open(os.path.join(d, 'views.json')))
    views = {}
    for v in meta['views']:
        M = np.array(v['matrix_world'], dtype=np.float64)
        W, H = v['width'], v['height']
        f = (W / 2) / np.tan(np.radians(v['fov_deg']) / 2)
        pos = np.load(os.path.join(d, f"view_{v['name']}_pos.npy"))
        views[v['name']] = View(
            name=v['name'], C=M[:3, 3], R=M[:3, :3].T, f=f, W=W, H=H,
            beauty=np.asarray(Image.open(os.path.join(d, f"view_{v['name']}_beauty.png")).convert('RGB')),
            pos=pos[..., :3], alpha=pos[..., 3] > 0.5,
            nrm=np.load(os.path.join(d, f"view_{v['name']}_nrm.npy")).astype(np.float32),
            uv=np.load(os.path.join(d, f"view_{v['name']}_uv.npy")))
    cov = np.load(os.path.join(d, 'texel_cov.npy'))
    T = cov.shape[0]
    idx = np.flatnonzero(cov.ravel())
    P = np.load(os.path.join(d, 'texel_pos.npy'), mmap_mode='r').reshape(-1, 3)[idx].astype(np.float32)
    Nrm = np.load(os.path.join(d, 'texel_nrm.npy'), mmap_mode='r').reshape(-1, 3)[idx].astype(np.float32)
    Nrm /= np.maximum(np.linalg.norm(Nrm, axis=1, keepdims=True), 1e-6)
    _, (iy, ix) = ndimage.distance_transform_edt(~cov, return_indices=True)
    pad = (iy * T + ix).astype(np.int32)
    s = Scene(name=name, T=T, views=views, cov=cov, idx=idx, P=P, Nrm=Nrm, pad=pad, vis={})
    for vn, view in views.items():
        s.vis[vn] = visibility(s, view)
    return s


def visibility(scene, view):
    """Texels visible in a view: (texel flat idx, u, v, quality)."""
    u, v, z = view.project(scene.P)
    ok = (z > 0.05) & (u >= 0) & (u < view.W) & (v >= 0) & (v < view.H)
    sel = np.flatnonzero(ok)
    u, v, z = u[sel], v[sel], z[sel]
    P, N = scene.P[sel], scene.Nrm[sel]
    to_cam = view.C[None, :].astype(np.float32) - P
    dist = np.linalg.norm(to_cam, axis=1)
    cos = np.einsum('ij,ij->i', N, to_cam) / np.maximum(dist, 1e-6)
    r = np.clip(v.astype(np.int64), 0, view.H - 1)
    c = np.clip(u.astype(np.int64), 0, view.W - 1)
    hit = view.pos[r, c]
    sky = ~view.alpha[r, c]
    d_hit = np.linalg.norm(hit - view.C[None, :].astype(np.float32), axis=1)
    visible = (cos > 0.08) & (sky | (dist <= d_hit + 0.02 + 0.01 * dist))
    keep = np.flatnonzero(visible)
    return {'tex': scene.idx[sel[keep]].astype(np.int64), 'u': u[keep].astype(np.float32),
            'v': v[keep].astype(np.float32), 'q': (cos[keep] / np.maximum(dist[keep], 0.5)).astype(np.float32)}


def bilinear(img, u, v):
    """Sample HxWxC image at continuous pixel coords (u, v) (pixel centres at +0.5)."""
    H, W = img.shape[:2]
    x = np.clip(u - 0.5, 0, W - 1)
    y = np.clip(v - 0.5, 0, H - 1)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, W - 1)
    y1 = np.minimum(y0 + 1, H - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    im = img.astype(np.float32)
    top = im[y0, x0] * (1 - fx) + im[y0, x1] * fx
    bot = im[y1, x0] * (1 - fx) + im[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def pixel_quality(view):
    """Same quality measure as visibility(), per pixel: cos(view angle) / distance."""
    to_cam = view.C[None, None, :].astype(np.float32) - view.pos
    dist = np.linalg.norm(to_cam, axis=-1)
    cos = np.einsum('ijk,ijk->ij', view.nrm, to_cam) / np.maximum(dist, 1e-6)
    return np.where(view.alpha, cos / np.maximum(dist, 0.5), 0).astype(np.float32)


class Texture:
    """Per-chain texture state: colour, known flag and capture quality per texel.

    With quality_ratio set, a known texel only counts as known to a later view if it was captured at
    >= ratio x the quality that view offers; otherwise that view regenerates and overwrites it.
    """

    def __init__(self, scene, quality_ratio=None):
        self.scene = scene
        self.ratio = quality_ratio
        T = scene.T
        self.rgb = np.zeros((T * T, 3), np.uint8)
        self.known = np.zeros(T * T, bool)
        self.q = np.zeros(T * T, np.float32)

    def _texels(self, view):
        T = self.scene.T
        x = np.clip((view.uv[..., 0] * T).astype(np.int64), 0, T - 1)
        y = np.clip(T - 1 - (view.uv[..., 1] * T).astype(np.int64), 0, T - 1)
        return self.scene.pad[y, x]

    def lookup(self, view):
        """Texel colour/known for each pixel of a view, via the UV pass (with UV edge padding)."""
        t = self._texels(view)
        known = self.known[t] & view.alpha
        if self.ratio:
            known &= self.q[t] >= self.ratio * pixel_quality(view)
        return self.rgb[t], known

    def state(self, view):
        """Image the model sees: known texels in colour, the rest as lit clay; plus the known mask."""
        rgb, known = self.lookup(view)
        img = np.where(known[..., None], rgb, view.beauty)
        return img.astype(np.uint8), known

    def project(self, view, image):
        vt = self.scene.vis[view.name]
        t_all = vt['tex']
        sel = ~self.known[t_all]
        if self.ratio:
            sel |= self.q[t_all] < self.ratio * vt['q']
        cols = bilinear(image, vt['u'][sel], vt['v'][sel])
        t = t_all[sel]
        self.rgb[t] = np.clip(cols + 0.5, 0, 255).astype(np.uint8)
        self.known[t] = True
        self.q[t] = vt['q'][sel]
        return int(sel.sum())

    def coverage(self, view):
        _, known = self.lookup(view)
        return float(known.sum() / max(view.alpha.sum(), 1))

    def save_preview(self, path, size=2048):
        T = self.scene.T
        img = Image.fromarray(self.rgb.reshape(T, T, 3)).resize((size, size), Image.BILINEAR)
        img.save(path, quality=90)


def edit_mask(view, known, grow=3):
    """Pixels to generate: geometry that isn't known yet, grown a little into the known side."""
    m = view.alpha & ~known
    if grow:
        m = ndimage.binary_dilation(m, iterations=grow) & view.alpha
    return m


def self_check(scene):
    """Reproject each view's position pass through our camera model; returns max pixel error."""
    errs = {}
    for vn, view in scene.views.items():
        rr, cc = np.nonzero(view.alpha)
        k = np.random.default_rng(0).choice(len(rr), size=min(20000, len(rr)), replace=False)
        rr, cc = rr[k], cc[k]
        u, v, _ = view.project(view.pos[rr, cc].astype(np.float64))
        errs[vn] = float(np.max(np.hypot(u - (cc + 0.5), v - (rr + 0.5))))
    return errs

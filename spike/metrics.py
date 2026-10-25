"""Per-view quality metrics for generated images.

align_*   : how far the output's edges sit from the true geometry edges (1-D search along the edge normal)
edge_miss : share of geometry edges with no matching edge in the output (structure ignored or moved a lot)
keep_dE   : how much the model changed pixels it should have kept (CIE76 dE, eroded known region)
seam      : gradient at the known/generated boundary vs. nearby, after pasting known pixels back (1 = seamless)
drift_px / scale : global affine shift/zoom between the clay render and the output (ECC on gradients)
"""
import cv2
import numpy as np
from scipy import ndimage


def lab(img):
    return cv2.cvtColor(img.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab)


def grad_mag(L, sigma):
    L = cv2.GaussianBlur(L, (0, 0), sigma)
    gx = cv2.Sobel(L, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(L, cv2.CV_32F, 0, 1, ksize=3)
    return gx, gy, np.hypot(gx, gy)


def geometry_edges(view, border=16):
    d = np.linalg.norm(view.pos - view.C[None, None, :].astype(np.float32), axis=-1)
    d[~view.alpha] = 1e4
    n = view.nrm
    e = np.zeros(view.alpha.shape, bool)
    for dy, dx in ((0, 1), (1, 0)):
        a = (slice(0, view.H - dy), slice(0, view.W - dx))
        b = (slice(dy, view.H), slice(dx, view.W))
        jump = np.abs(d[a] - d[b]) / np.minimum(d[a], d[b]) > 0.03
        crease = np.einsum('ijk,ijk->ij', n[a], n[b]) < np.cos(np.radians(25))
        sil = view.alpha[a] != view.alpha[b]
        e[a] |= jump | crease | sil
    e[:border] = e[-border:] = False
    e[:, :border] = e[:, -border:] = False
    return e


def _profile(G, pts, nrm, offsets):
    xs = pts[:, 1][:, None] + nrm[:, 0][:, None] * offsets[None, :]
    ys = pts[:, 0][:, None] + nrm[:, 1][:, None] * offsets[None, :]
    return cv2.remap(G, xs.astype(np.float32), ys.astype(np.float32), cv2.INTER_LINEAR)


def edge_alignment(view, out, edges, max_off=12, n_pts=4000, seed=0):
    Lr = lab(view.beauty)[..., 0]
    gx, gy, gr = grad_mag(Lr, 1.5)
    pts = np.argwhere(edges)
    pts = pts[gr[pts[:, 0], pts[:, 1]] > 4.0]            # edges the clay render actually shows
    if len(pts) == 0:
        return {'align_med_px': float('nan'), 'align_mean_px': float('nan'), 'edge_miss': float('nan')}
    rng = np.random.default_rng(seed)
    pts = pts[rng.choice(len(pts), size=min(n_pts, len(pts)), replace=False)]
    nrm = np.stack([gx[pts[:, 0], pts[:, 1]], gy[pts[:, 0], pts[:, 1]]], 1)
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    offsets = np.arange(-max_off, max_off + 1, dtype=np.float32)
    _, _, go = grad_mag(lab(out)[..., 0], 1.5)
    prof = _profile(go, pts, nrm, offsets)
    best = offsets[np.argmax(prof, 1)]
    found = prof.max(1) >= np.percentile(go, 75)
    off = np.abs(best[found])
    return {'align_med_px': float(np.median(off)) if len(off) else float('nan'),
            'align_mean_px': float(off.mean()) if len(off) else float('nan'),
            'edge_miss': float(1 - found.mean())}


def keep_error(state, out, known, alpha):
    k = ndimage.binary_erosion(known, iterations=5) & alpha
    if k.sum() < 500:
        return {'keep_dE': float('nan'), 'keep_dE_p90': float('nan')}
    dE = np.linalg.norm(lab(out) - lab(state), axis=-1)[k]
    return {'keep_dE': float(dE.mean()), 'keep_dE_p90': float(np.percentile(dE, 90))}


def seam(view, comp, known, edges):
    unknown = view.alpha & ~known
    if unknown.sum() < 500 or known.sum() < 500:
        return {'seam': float('nan')}
    _, _, G = grad_mag(lab(comp)[..., 0], 1.0)
    d_u = ndimage.distance_transform_edt(~known)       # for unknown pixels: distance to known
    d_k = ndimage.distance_transform_edt(known)        # for known pixels: distance to unknown
    near_geo = ndimage.binary_dilation(edges, iterations=3)
    band = ((unknown & (d_u <= 2)) | (known & (d_k <= 1))) & view.alpha & ~near_geo
    ring = (((unknown & (d_u >= 4) & (d_u <= 12)) | (known & (d_k >= 4) & (d_k <= 12)))
            & view.alpha & ~near_geo)
    if band.sum() < 100 or ring.sum() < 100:
        return {'seam': float('nan')}
    return {'seam': float(G[band].mean() / max(G[ring].mean(), 1e-6))}


def drift(view, out):
    _, _, a = grad_mag(lab(view.beauty)[..., 0], 2.0)
    _, _, b = grad_mag(lab(out)[..., 0], 2.0)
    a = cv2.resize(a, (512, 512), interpolation=cv2.INTER_AREA)
    b = cv2.resize(b, (512, 512), interpolation=cv2.INTER_AREA)
    a /= max(a.max(), 1e-6)
    b /= max(b.max(), 1e-6)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        cc, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
    except cv2.error:
        return {'drift_px': float('nan'), 'scale': float('nan')}
    return {'drift_px': float(np.hypot(*warp[:, 2]) * 2), 'scale': float(np.sqrt(abs(np.linalg.det(warp[:, :2]))))}


def blend(state, out, known, alpha, mode):
    """Put generated pixels back next to known ones.

    hard    : paste known pixels exactly
    match   : first shift the generated region's Lab mean/std to the known ring around the boundary
    feather : also fade the generated image into the known side over 6 px
    """
    if mode == 'hard':
        return np.where(known[..., None], state, out).astype(np.uint8)
    unknown = alpha & ~known
    o = out
    if mode in ('match', 'match+feather'):
        d_u = ndimage.distance_transform_edt(~known)
        d_k = ndimage.distance_transform_edt(known)
        ring_g = unknown & (d_u <= 16)
        ring_k = known & alpha & (d_k <= 16)
        if ring_g.sum() > 200 and ring_k.sum() > 200:
            lo, ls = lab(out), lab(state)
            mu_g, sd_g = lo[ring_g].mean(0), lo[ring_g].std(0) + 1e-3
            mu_k, sd_k = ls[ring_k].mean(0), ls[ring_k].std(0) + 1e-3
            adj = (lo - mu_g) / sd_g * np.sqrt(sd_g * sd_k) + mu_k   # half-strength contrast match
            rgb = cv2.cvtColor(adj.astype(np.float32), cv2.COLOR_Lab2RGB)
            o = np.where(unknown[..., None], np.clip(rgb * 255 + 0.5, 0, 255), out).astype(np.uint8)
    res = np.where(known[..., None], state, o).astype(np.float32)
    if mode in ('feather', 'match+feather'):
        d_k = ndimage.distance_transform_edt(known)
        w = np.clip(d_k / 6.0, 0, 1)[..., None]                        # 0 at the boundary -> 1 inside
        side = (known & alpha & (d_k <= 6))[..., None]
        res = np.where(side, w * state + (1 - w) * o, res)
    return np.clip(res + 0.5, 0, 255).astype(np.uint8)


BLENDS = ('hard', 'match', 'feather', 'match+feather')


def view_metrics(view, state, out, comp, known, first):
    edges = geometry_edges(view)
    m = {}
    m.update(edge_alignment(view, out, edges))
    m.update(drift(view, out))
    if not first:
        m.update(keep_error(state, out, known, view.alpha))
        for mode in BLENDS:
            c = comp if mode == 'hard' else blend(state, out, known, view.alpha, mode)
            m['seam' if mode == 'hard' else f'seam_{mode}'] = seam(view, c, known, edges)['seam']
    return m

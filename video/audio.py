#!/usr/bin/env python3
"""Soundtrack for the demo: the generated score plus quiet, round UI sounds timed from video/out/timeline.json.

  python3 video/audio.py   -> video/out/audio_mix.wav and video/out/audio_sfx.wav (no music)
"""
import json
import os
import subprocess
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'video', 'out')
SR = 48000
RNG = np.random.default_rng(11)
PENTA = [0, 2, 4, 7, 9]                     # major pentatonic steps


def hz(semitones_from_a4):
    return 440.0 * 2 ** (semitones_from_a4 / 12)


def env(n, attack, decay):
    t = np.arange(n) / SR
    return np.where(t < attack, t / max(attack, 1e-6), np.exp(-(t - attack) / max(decay, 1e-6))).astype(np.float32)


def pop(f, gain=0.12, dur=0.22):
    """Soft round pop: sine with a quick downward glide and a short tail, plus a quiet octave."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    freq = f * (1 + 0.35 * np.exp(-t / 0.012))
    ph = 2 * np.pi * np.cumsum(freq) / SR
    w = np.sin(ph) + 0.18 * np.sin(2 * ph)
    return (w * env(n, 0.003, 0.055) * gain).astype(np.float32)


def tick(f, gain=0.035):
    n = int(SR * 0.05)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * t) * env(n, 0.001, 0.012) * gain).astype(np.float32)


def noise_band(n, lo, hi):
    x = RNG.normal(0, 1, n)
    X = np.fft.rfft(x)
    fr = np.fft.rfftfreq(n, 1 / SR)
    X[(fr < lo) | (fr > hi)] = 0
    x = np.fft.irfft(X, n)
    return (x / (np.abs(x).max() + 1e-9)).astype(np.float32)


def whoosh(gain=0.06, dur=0.45):
    n = int(SR * dur)
    t = np.linspace(0, 1, n)
    shape = np.sin(np.pi * t) ** 2
    return (noise_band(n, 300, 3500) * shape * gain).astype(np.float32)


def bloom(freqs, gain=0.07, dur=1.8):
    n = int(SR * dur)
    t = np.arange(n) / SR
    w = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    e = np.minimum(1, t / 0.25) * np.exp(-np.maximum(0, t - 0.25) / 0.7)
    return (w * e * gain).astype(np.float32)


def chime(freqs, gain=0.08, dur=2.2):
    n = int(SR * dur)
    t = np.arange(n) / SR
    w = sum(np.sin(2 * np.pi * f * t) * np.exp(-t / (0.9 / (k + 1))) for k, f in enumerate(freqs))
    return (w * np.minimum(1, t / 0.004) * gain / len(freqs)).astype(np.float32)


def place(buf, clip, t):
    i = int(t * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(clip))
    buf[i:j] += clip[: j - i]


def load_music(path, n):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).reshape(-1, 2)
    out = np.zeros((n, 2), np.float32)
    out[: min(n, len(x))] = x[:n]
    return out


def write(path, x):
    y = np.clip(x, -1, 1)
    pcm = (y * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    tl = json.load(open(os.path.join(OUT, 'timeline.json')))
    sec = {s['name']: s for s in tl['sections']}
    dur = len(tl['frames']) / tl['fps']
    n = int(dur * SR)
    sfx = np.zeros(n, np.float32)
    # hook: a soft rising swoosh into the first downbeat, then a bloom as the texture sweeps in
    sweep = tl['beats']['bars'][0]
    place(sfx, whoosh(0.05, 0.7), max(0.0, sweep - 0.6))
    place(sfx, bloom([hz(3), hz(7), hz(10)], 0.05, 2.2), sweep)
    # montage + section cuts: a breath of air on each cut
    for name in ('montage', 'plan', 'paint', 'result'):
        place(sfx, whoosh(0.03, 0.35), sec[name]['start'] - 0.12)
    for f in tl['frames']:
        if f['section'] == 'montage' and f.get('shot') == 1:
            place(sfx, whoosh(0.03, 0.35), f['time'] - 0.12)
            break
    # plan: quiet ticks as spots and cameras appear (thinned so it stays calm)
    plan_frames = [f for f in tl['frames'] if f['section'] == 'plan']
    pts, cams = tl['data']['points'], tl['data']['views']
    smooth = lambda x: (lambda c: c * c * (3 - 2 * c))(max(0.0, min(1.0, x)))
    prev_p = prev_c = 0
    for f in plan_frames:
        t = f['t']
        p = int(pts * smooth(t / 0.35))                 # same curves as scripts/capture.mjs
        c = int(cams * smooth((t - 0.3) / 0.5))
        if p // 3 > prev_p // 3:
            place(sfx, tick(hz(15 + PENTA[(p // 3) % 5]), 0.03), f['time'])
        if c // 6 > prev_c // 6:
            place(sfx, tick(hz(22 + PENTA[(c // 6) % 5]), 0.022), f['time'])
        prev_p, prev_c = p, c
    # paint: one round pop per reveal slot, climbing the pentatonic scale with progress
    last_slot = -1
    paint_frames = [f for f in tl['frames'] if f['section'] == 'paint' and f.get('paint')]
    total_slots = max(f['paint']['slot'] for f in paint_frames) + 1
    for f in paint_frames:
        s = f['paint']['slot']
        if s != last_slot and f['paint']['slotWaves'][1] > f['paint']['slotWaves'][0]:
            step = int(10 * s / max(1, total_slots - 1))
            semis = 3 + 12 * (step // 5) + PENTA[step % 5]
            place(sfx, pop(hz(semis), 0.10 if s else 0.14), f['time'])
            last_slot = s
    # end card: a gentle chime
    place(sfx, chime([hz(15), hz(19), hz(22), hz(27)], 0.09), sec['end']['start'] + 0.05)

    stereo_sfx = np.stack([sfx, sfx], 1)
    track = os.path.join(ROOT, 'video', 'audio', 'music.mp3')
    if os.path.exists(track):
        music = load_music(track, n)
    else:   # the score isn't in the repo: mix the UI sounds alone
        print('no video/audio/music.mp3: mixing without music')
        music = np.zeros((n, 2), np.float32)
    fade = np.ones(n, np.float32)
    k = int(0.6 * SR)
    fade[-k:] = np.linspace(1, 0, k)
    mix = music * 0.82 + stereo_sfx
    mix *= fade[:, None]
    peak = np.abs(mix).max()
    write(os.path.join(OUT, 'audio_mix.wav'), mix * (0.89 / peak))
    sp = np.abs(stereo_sfx).max()
    write(os.path.join(OUT, 'audio_sfx.wav'), stereo_sfx * fade[:, None] * (0.7 / max(sp, 1e-6)))
    print('wrote audio_mix.wav and audio_sfx.wav', round(dur, 2), 's')


if __name__ == '__main__':
    main()

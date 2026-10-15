#!/usr/bin/env python3
"""Measure voice recordings against published delivery standards and a reference.

usage: bench.py --ref produced.wav file1 file2 ...   (prints a JSON list)

Metrics
  lufs, lra, tp      EBU R128 integrated loudness, loudness range, true peak (via ffmpeg)
  rms_db, peak_db    ACX-style whole-file RMS and sample peak (dBFS)
  noise_db           quietest 500 ms window that is not digital silence (ACX noise-floor style)
  silence_pct        share of 500 ms windows that are digital silence (over-gating)
  ltas               long-term average spectrum of speech, 1/3-octave bands, 0 dB at 1 kHz
  tone_err_db        mean |dB| difference of ltas vs the reference (100 Hz - 10 kHz)
"""
import json, re, subprocess, sys
import numpy as np, soundfile as sf
from scipy.signal import welch

BANDS = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
         2500, 3150, 4000, 5000, 6300, 8000, 10000]


def r128(path):
    out = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true',
                          '-f', 'null', '-'], capture_output=True, text=True).stderr
    s = out[out.rfind('Summary:'):]
    g = lambda k: float(re.search(k + r':\s+(-?[\d.]+|-inf)', s).group(1).replace('-inf', '-120'))
    return g('I'), g('LRA'), g('Peak')


def ltas(x, sr):
    win = int(sr * 0.03)
    frames = [x[i:i + win] for i in range(0, len(x) - win, win)]
    rms = np.array([np.sqrt(np.mean(f ** 2)) + 1e-12 for f in frames])
    db = 20 * np.log10(rms)
    voiced = np.concatenate([f for f, d in zip(frames, db) if d > db.max() - 30])  # speech only
    f, p = welch(voiced, sr, nperseg=4096)
    out = []
    for c in BANDS:
        lo, hi = c / 2 ** (1 / 6), c * 2 ** (1 / 6)
        m = (f >= lo) & (f < hi)
        out.append(10 * np.log10(p[m].mean() + 1e-20))
    out = np.array(out)
    return out - out[BANDS.index(1000)]


def measure(path):
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(axis=1)
    lufs, lra, tp = r128(path)
    rms_db = 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)
    peak_db = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    w = int(sr * 0.5)
    wr = np.array([np.sqrt(np.mean(x[i:i + w] ** 2)) for i in range(0, len(x) - w, w // 2)])
    silent = wr < 1e-6
    nz = wr[~silent]
    noise_db = float(20 * np.log10(nz.min())) if len(nz) else -120.0
    return dict(file=path.split('/')[-1], lufs=round(lufs, 1), lra=round(lra, 1), tp=round(tp, 1),
                rms_db=round(float(rms_db), 1), peak_db=round(float(peak_db), 1),
                noise_db=round(noise_db, 1), silence_pct=round(100 * float(silent.mean()), 1),
                ltas=[round(float(v), 1) for v in ltas(x, sr)])


if __name__ == '__main__':
    args = sys.argv[1:]
    ref = None
    if args[:1] == ['--ref']:
        ref, args = args[1], args[2:]
    refm = measure(ref) if ref else None
    rows = []
    for p in args:
        m = measure(p)
        if refm:
            sel = [i for i, c in enumerate(BANDS) if 100 <= c <= 10000]
            m['tone_err_db'] = round(float(np.mean([abs(m['ltas'][i] - refm['ltas'][i]) for i in sel])), 1)
        rows.append(m)
    print(json.dumps({'bands': BANDS, 'ref': refm, 'rows': rows}, indent=1))

"""Pitch center of a track's tonal part (Hz), the measure Ben's taste in songs tracks: deeper wins.

    pitch.py FILE [FILE ...]  ->  one line each: name, average, low, high, range

The energy-weighted median frequency of the harmonic part (80 Hz-5 kHz) in 2 s windows every 0.5 s, smoothed over
five windows; the quietest 10% of moments are skipped so silences don't drag the numbers.
"""
import os, sys

import librosa
import numpy as np


def pitch(fn):
    y, sr = librosa.load(fn, sr=22050, mono=True)
    harm, _ = librosa.effects.hpss(y)
    hop = 512
    S = np.abs(librosa.stft(harm, n_fft=4096, hop_length=hop))
    f = librosa.fft_frequencies(sr=sr, n_fft=4096)
    band = (f > 80) & (f < 5000)
    fps = sr / hop
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    quiet = np.percentile(rms, 10)
    vals, t = [], 0.0
    while t + 2 <= len(y) / sr:
        a, b = int(t * fps), int((t + 2) * fps)
        e = S[band, a:b].sum(1)
        if e.sum() > 0 and rms[a:b].mean() > quiet:
            vals.append(f[band][np.searchsorted(np.cumsum(e) / e.sum(), 0.5)])
        t += 0.5
    v = np.convolve(vals, np.ones(5) / 5, mode="valid")
    return v.mean(), v.min(), v.max()


if __name__ == "__main__":
    for fn in sys.argv[1:]:
        m, lo, hi = pitch(fn)
        print(f"{os.path.splitext(os.path.basename(fn))[0]:>6}  average {m:5.0f} Hz  low {lo:5.0f}  high {hi:5.0f}  range {hi - lo:4.0f}")

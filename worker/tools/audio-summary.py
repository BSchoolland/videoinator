"""A written account of a video's soundtrack for a reviewer who can't hear it.

    audio-summary.py VIDEO > audio.txt

Tempo, a per-second loudness timeline (relative to the track's own range), the biggest hits, where the music builds,
drops and goes quiet, and how the picture's cuts line up with the music. The numbers are the same ones reel.qa gives
the critic. Uses no knowledge of the project: only the video file.
"""
import subprocess, sys

import numpy as np

from reel import music, qa

SR = 22050


def loudness(fn):
    """Per-second RMS in dB."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", fn, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True, check=True)
    x = np.frombuffer(p.stdout, np.float32)
    n = len(x) // SR
    rms = np.sqrt((x[: n * SR].reshape(n, SR) ** 2).mean(1))
    return 20 * np.log10(rms + 1e-9)


def main(fn):
    dur = qa.duration(fn)
    db = loudness(fn)
    lo, hi = np.percentile(db, 5), db.max()
    t, f = music.flux(fn)
    pt, pv = music.peaks(t, f)
    out = [f"Soundtrack of a {dur:.0f} s video (you can't hear it; this is what it does).", ""]

    if len(pt) > 8:
        gaps = np.diff(pt[pv > 2.0]) if (pv > 2.0).sum() > 8 else np.diff(pt)
        beat = np.median(gaps[(gaps > 0.25) & (gaps < 1.2)]) if ((gaps > 0.25) & (gaps < 1.2)).any() else None
        if beat:
            out.append(f"Tempo: roughly {60 / beat:.0f} BPM.")
    out.append("")
    out.append("Loudness, second by second (0 = the track's quietest stretch, 10 = its loudest moment):")
    rows = []
    for s, v in enumerate(db):
        level = int(round(np.clip((v - lo) / max(hi - lo, 1e-6), 0, 1) * 10))
        rows.append(f"{s // 60}:{s % 60:02d} {'#' * level:<10} {level}")
    out += rows
    out.append("")

    # sections: sustained changes in level
    smooth = np.convolve(db, np.ones(3) / 3, mode="same")
    notes = []
    for s in range(2, len(smooth)):
        d = smooth[s] - smooth[s - 2]
        if d > 6:
            notes.append(f"{s // 60}:{s % 60:02d} the music kicks in / gets much bigger")
        elif d < -6:
            notes.append(f"{s // 60}:{s % 60:02d} the music drops away / gets much quieter")
    silence = [s for s, v in enumerate(db) if v < -45 and 1 < s < len(db) - 2]
    for s in silence:
        notes.append(f"{s // 60}:{s % 60:02d} near-silence")
    dedup, last = [], -9
    for n in notes:
        s = int(n.split()[0].split(":")[0]) * 60 + int(n.split()[0].split(":")[1])
        if s - last > 2:
            dedup.append(n)
        last = s
    out.append("Changes in the music:" if dedup else "Changes in the music: none big; it stays at a similar level throughout.")
    out += [f"  {n}" for n in dedup]
    out.append("")

    top = sorted(zip(pv, pt), reverse=True)[:12]
    out.append("The biggest hits (strongest beats/impacts), in time order:")
    out += [f"  {int(x) // 60}:{x % 60:05.2f}" for _, x in sorted(top, key=lambda y: y[1])]
    out.append("")

    cuts = qa.scene_cuts(fn)
    if cuts and len(pt):
        off = np.array([pt[np.abs(pt - c).argmin()] - c for c in cuts])
        near = (np.abs(off) <= 0.05).mean() * 100
        out.append(f"Picture cuts: {len(cuts)}; {near:.0f}% of them land on a beat or hit in the music.")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])

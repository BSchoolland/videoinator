// suno-record OUTDIR name:clipid [name:clipid ...] -> OUTDIR/<name>.mp3 for each Suno clip, from Ben's Chrome.
// Suno encrypts its stream, so each clip plays in its own tab and is recorded in the page (captureStream +
// MediaRecorder, real time), then pulled out over CDP. Callers hold the Suno lock.
import { createRequire } from "module";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("/home/ben/Projects/TACOS/package.json");
const { chromium } = require("@playwright/test");
const [out, ...pairs] = process.argv.slice(2);
if (!out || !pairs.length) { console.error("usage: suno-record OUTDIR name:clipid [...]"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
let failed = false;
for (const pair of pairs) {
  const [name, id] = pair.split(":");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "")) { console.error(`FAIL ${name}: ${id} is not a Suno clip id`); failed = true; continue; }
  const page = await ctx.newPage();
  try {
    await page.goto(`https://suno.com/song/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    // the player only gets its decrypted blob once Play is pressed
    await page.evaluate(() => { document.querySelectorAll("audio").forEach((a) => a.pause()); [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Play")?.click(); });
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some((a) => a.src.startsWith("blob:") && a.duration > 0), null, { timeout: 30000 });
    const dur = await page.evaluate(async () => {
      const a = [...document.querySelectorAll("audio")].find((a) => a.src.startsWith("blob:"));
      const s = a.captureStream();
      // the capture only gets its audio track once the element is actually playing
      if (a.paused) await a.play();
      for (let i = 0; i < 50 && !s.getAudioTracks().length; i++) await new Promise((r) => setTimeout(r, 100));
      if (!s.getAudioTracks().length) throw new Error("the player never produced an audio track to record");
      a.pause(); a.currentTime = 0;
      await new Promise((r) => setTimeout(r, 500));
      const rec = new MediaRecorder(s, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 320000 });
      const chunks = [];
      window.__rec = { done: false };
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => { window.__rec.buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); window.__rec.done = true; };
      a.onended = () => setTimeout(() => rec.stop(), 300);
      rec.start(1000);
      await a.play();
      return a.duration;
    });
    await page.waitForFunction(() => window.__rec?.done, null, { timeout: (dur + 60) * 1000, polling: 1000 });
    const webm = path.join(out, `raw-${name}.webm`);
    const n = await page.evaluate(() => window.__rec.buf.length);
    const fd = fs.openSync(webm, "w");
    for (let o = 0; o < n; o += 1 << 20) {
      const b64 = await page.evaluate(([o, len]) => { const b = window.__rec.buf.subarray(o, o + len); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }, [o, 1 << 20]);
      fs.writeSync(fd, Buffer.from(b64, "base64"));
    }
    fs.closeSync(fd);
    const mp3 = path.join(out, `${name}.mp3`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", webm, "-t", String(dur), "-b:a", "320k", mp3]);
    const vd = spawnSync("ffmpeg", ["-i", mp3, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const peak = Number(/max_volume: (-?[\d.]+)/.exec(vd)?.[1]);
    const got = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString());
    if (!(peak > -40)) { console.error(`FAIL ${name}: the recording is silent (peak ${peak} dB)`); failed = true; }
    else if (Math.abs(got - dur) > 2) { console.error(`FAIL ${name}: recorded ${got.toFixed(1)}s of a ${dur.toFixed(1)}s clip`); failed = true; }
    else console.log(`OK ${name} ${id} ${got.toFixed(1)}s peak ${peak}dB -> ${mp3}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`); failed = true;
  } finally {
    await page.close();
  }
}
await browser.close(); // over CDP this only disconnects; Ben's Chrome stays up

// the grading every take in OUTDIR gets, earlier rounds included; it's here, not in the music prompt, so it shapes
// which take wins without shaping what's asked of Suno
const takes = fs.readdirSync(out).filter((f) => f.endsWith(".mp3") && f !== "song.mp3").sort().map((f) => path.join(out, f));
if (takes.length) {
  const py = path.join(path.dirname(fs.realpathSync(process.argv[1])), "../../reel/.venv/bin/python");
  const stats = execFileSync(py, [path.join(path.dirname(fs.realpathSync(process.argv[1])), "pitch.py"), ...takes], { encoding: "utf8" });
  console.log(`
How to grade these takes (pitch center of each one's tonal part):
${stats}
Ben's ear runs on this: deeper songs win. Every song he's liked averages 1,500 Hz or lower (his favorite, 1,240); the
ones he called flops average 1,520-1,660. Rule out any take averaging above 1,500 Hz unless they all do. Among the
rest, a lower average and a wide swing (a low bed the climaxes rise out of) beat a flat one; then a clean final hit
and room for drops.`);
}
process.exit(failed ? 1 : 0);

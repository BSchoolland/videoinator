// One video: a reel project from the chat, then director (who makes the music first) -> critic -> director ->
// share encode -> upload.
// Every stage leaves a marker in the project, so a job reclaimed after a worker restart resumes where it stopped.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatDir, RUNS } from "./planner.ts";
import { post, upload, SITE, type Chat, type Job, type Message, type User } from "./site.ts";

const here = import.meta.dirname;
const REEL = path.join(here, "../reel");
const PY = path.join(REEL, ".venv/bin/python");
const STATS = path.join(RUNS, "stage-minutes.json");
const MODEL = process.env.DIRECTOR_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.DIRECTOR_EFFORT ?? "xhigh";

/** Expected minutes per stage until real runs replace them (mean of the last five of each). */
const DEFAULT_MINUTES: Record<string, number> = { setup: 2, director1: 58, critic: 12, director2: 35, deliver: 3 };
const STAGES = Object.keys(DEFAULT_MINUTES);
const LABEL: Record<string, string> = {
  setup: "setting up", director1: "music and the first cut", critic: "the critic is watching",
  director2: "final cut", deliver: "wrapping it up",
};

class Broken extends Error {}

function minutes(): Record<string, number> {
  const hist: Record<string, number[]> = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, "utf8")) : {};
  return Object.fromEntries(STAGES.map((s) => {
    const h = (hist[s] ?? []).slice(-5);
    return [s, h.length ? h.reduce((a, b) => a + b, 0) / h.length : DEFAULT_MINUTES[s]];
  }));
}
function record(stage: string, mins: number) {
  const hist: Record<string, number[]> = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, "utf8")) : {};
  (hist[stage] ??= []).push(Math.round(mins * 10) / 10);
  fs.writeFileSync(STATS, JSON.stringify(hist));
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const prompt = (name: string, vars: Record<string, string>) => fill(fs.readFileSync(path.join(here, "prompts", name), "utf8"), vars);

/** A claude session in dir; resolves when it exits. Its stream goes to logFile. */
function agent(dir: string, text: string, logFile: string, opts: { effort: string; signal: AbortSignal; env?: Record<string, string> }): Promise<number> {
  const args = ["-p", "--model", MODEL, "--effort", opts.effort, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"];
  return new Promise((resolve, reject) => {
    const out = fs.openSync(logFile, "a");
    const child = spawn("claude", args, { cwd: dir, stdio: ["pipe", out, out], env: { ...process.env, ...opts.env }, signal: opts.signal });
    child.on("error", (e) => { fs.closeSync(out); reject(e); });
    child.on("close", (code) => { fs.closeSync(out); resolve(code ?? -1); });
    child.stdin!.end(text);
  });
}

/** The cold viewer: may only Read, from a directory holding nothing but its frame sheets. Resolves with its reply. */
function coldViewer(cwd: string, text: string, logFile: string, signal: AbortSignal): Promise<string> {
  const args = ["-p", "--model", MODEL, "--effort", "high", "--tools", "Read", "--allowedTools", "Read",
    "--permission-mode", "dontAsk", "--output-format", "stream-json", "--verbose"];
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    let buf = "", result = "";
    child.stdout.on("data", (d) => {
      log.write(d); buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.includes('"type":"result"')) result = String(JSON.parse(line).result ?? "");
      }
    });
    child.stderr.on("data", (d) => log.write(d));
    child.on("error", (e) => { log.end(); reject(e); });
    child.on("close", () => { log.end(); resolve(result); });
    child.stdin!.end(text);
  });
}

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  return r.stdout;
}

function brief(dir: string, job: Job, msgs: Message[], user: User) {
  const plan = msgs.find((m) => m.id === job.plan_msg_id);
  if (!plan) throw new Error(`plan message ${job.plan_msg_id} is not in the chat`);
  const refsDir = path.join(chatDir(job.chat_id), "refs");
  const refs: string[] = [];
  fs.mkdirSync(path.join(dir, "assets/ref"), { recursive: true });
  if (fs.existsSync(refsDir)) for (const f of fs.readdirSync(refsDir)) {
    if (f.endsWith("-sheet.jpg")) continue;
    fs.copyFileSync(path.join(refsDir, f), path.join(dir, "assets/ref", f));
    refs.push(`- \`assets/ref/${f}\``);
  }
  const chat = msgs.map((m) => {
    const who = m.sender === "user" ? user.name : "Planner";
    const media = m.media.length ? ` [showed ${m.media.length} reference${m.media.length > 1 ? "s" : ""}]` : "";
    return `**${who}**${m.kind === "plan" ? " (plan)" : ""}: ${m.body}${media}`;
  }).join("\n\n");
  const title = plan.body.split("\n").find((l) => l.trim())?.replace(/^[#*\s]+|[*\s]+$/g, "").slice(0, 80) ?? "Epic video";
  fs.writeFileSync(path.join(dir, "BRIEF.md"), prompt("BRIEF.md", {
    TITLE: title, NAME: `for ${user.name}`, PLAN: plan.body,
    REFS: refs.length ? `What the planner found and showed them (look at every one):\n${refs.join("\n")}` : "None were shown.",
    CHAT: chat,
  }));
  fs.writeFileSync(path.join(dir, "video.toml"), 'song = "assets/song.mp3"\n');
  return plan.body;
}

export async function makeVideo(j: { job: Job; chat: Chat; messages: Message[]; user: User }, log: (s: string) => void, signal: AbortSignal): Promise<void> {
  const { job } = j;
  const dir = path.join(RUNS, "jobs", job.id);
  for (const d of ["assets", "work", "out", "art"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const mins = minutes();
  const total = STAGES.reduce((a, s) => a + mins[s], 0);
  let stage = "setup", stageStart = Date.now(), ran = true;

  const report = async () => {
    const done = STAGES.slice(0, STAGES.indexOf(stage)).reduce((a, s) => a + mins[s], 0);
    const inStage = Math.min((Date.now() - stageStart) / 60000, mins[stage] * 0.95);
    const remaining = total - done - inStage;
    await post(`/jobs/${job.id}/progress`, { stage: LABEL[stage], pct: (done + inStage) / total, eta_at: Date.now() + remaining * 60000 });
  };
  const heartbeat = setInterval(() => report().catch((e) => log(`progress failed: ${e.message}`)), 60_000);
  // a stage a resumed job skips (its marker exists) says nothing about how long the stage takes
  const enter = async (s: string) => {
    if (ran) record(stage, (Date.now() - stageStart) / 60000);
    stage = s; stageStart = Date.now(); ran = false;
    log(`stage ${s}`);
    await report();
  };
  const broken = () => { const f = path.join(dir, "BROKEN.md"); if (fs.existsSync(f)) throw new Broken(fs.readFileSync(f, "utf8").trim()); };

  try {
    await report();
    brief(dir, job, j.messages, j.user);

    for (const n of [1, 2]) {
      await enter(`director${n}`);
      const marker = path.join(dir, `cycle-${n}.rendered`);
      for (let attempt = 1; attempt <= 2 && !fs.existsSync(marker); attempt++) {
        ran = true;
        await agent(dir, prompt("DIRECTOR.md", {
          N: String(n), DIR: dir,
          CYCLE_NOTE: n === 2 ? "Two reviews of your first cut: coldview-c1.md is a viewer who saw only the frames (no brief, no chat) and says what they think the video is about and where they got lost; critique-c1.md is a blind critic's ranked review. Read both first. If the cold viewer's \"What it's about\" doesn't match the plan in BRIEF.md, or they got lost anywhere, fixing that comes before everything else: the story has to read without the brief. Then fix what the critic ranks highest; structural complaints beat polish."
            : fs.existsSync(path.join(dir, "assets/song.mp3")) ? "" : prompt("MUSIC.md", { TOOLS: path.join(here, "tools") }),
        }), path.join(dir, `director-c${n}.log`), { effort: EFFORT, signal, env: { PATH: `${path.dirname(PY)}:${process.env.PATH}` } });
        broken();
      }
      if (!fs.existsSync(marker)) throw new Error(`the cycle ${n} director exited twice without a render`);
      for (const f of ["assets/song.mp3", "work/audio.json", `out/cycle-${n}-master.mp4`])
        if (!fs.existsSync(path.join(dir, f))) throw new Error(`the cycle ${n} director marked its render done without ${f}`);
      if (n === 2) break;

      await enter("critic");
      const critique = path.join(dir, "critique-c1.md");
      if (!fs.existsSync(critique) || !fs.statSync(critique).size) {
        const text = fill(fs.readFileSync(path.join(REEL, "CRITIC.md"), "utf8"), {
          CANDIDATE: path.join(dir, "out/cycle-1-master.mp4"), PROJECT: dir, WORK: path.join(dir, "critic-c1"), OUT: critique,
        });
        ran = true;
        await agent(dir, text, path.join(dir, "critic-c1.log"), { effort: EFFORT, signal, env: { PATH: `${path.dirname(PY)}:${process.env.PATH}` } });
        if (!fs.existsSync(critique) || !fs.statSync(critique).size) throw new Error("the critic wrote no critique");
      }
      // a cold viewer: only the frames, no brief, no chat, no code, nowhere near the project, says what it thinks the
      // video is about and where it got lost
      const coldview = path.join(dir, "coldview-c1.md");
      if (!fs.existsSync(coldview) || !fs.statSync(coldview).size) {
        const cold = path.join(os.tmpdir(), `videoinator-coldview-${job.id}`);
        fs.rmSync(cold, { recursive: true, force: true });
        fs.mkdirSync(cold, { recursive: true });
        sh("ffmpeg", ["-v", "error", "-i", path.join(dir, "out/cycle-1-master.mp4"), "-vf",
          "fps=4,scale=360:-2,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=3x3",
          path.join(cold, "sheet_%02d.jpg")], cold);
        // the standing reference: a video viewers really liked, in the same format (see worker/prompts/COLDVIEW.md)
        fs.cpSync(path.join(RUNS, "coldview-ref"), path.join(cold, "ref"), { recursive: true });
        fs.writeFileSync(path.join(cold, "audio.txt"), sh(PY, [path.join(here, "tools/audio-summary.py"), path.join(dir, "out/cycle-1-master.mp4")], cold));
        ran = true;
        const seen = await coldViewer(cold, prompt("COLDVIEW.md", {}), path.join(dir, "coldview-c1.log"), signal);
        if (!seen.includes("## What it")) throw new Error(`the cold viewer gave no review: ${seen.slice(0, 300)}`);
        fs.writeFileSync(coldview, seen.slice(seen.indexOf("## What it")));
      }
    }

    await enter("deliver");
    const share = path.join(dir, "out/cycle-2-share.mp4");
    if (!fs.existsSync(share)) { sh(PY, ["-m", "reel.deliver", path.join(dir, "out/cycle-2-master.mp4"), share], dir); ran = true; }
    if (ran) record("deliver", (Date.now() - stageStart) / 60000);
    // the still a shared link previews with: a frame 40% in, past the opening title
    const posterFile = path.join(dir, "out/poster.jpg");
    const dur = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", share], dir));
    sh("ffmpeg", ["-v", "error", "-y", "-ss", String(dur * 0.4), "-i", share, "-frames:v", "1", "-q:v", "3", posterFile], dir);
    const { url: posterUrl } = await upload<{ url: string }>("/media?ext=jpg", posterFile);
    const r = await upload<{ video: string }>(`/jobs/${job.id}/done?poster=${path.basename(posterUrl)}`, share);
    log(`DONE ${SITE}${r.video}`);
  } finally {
    clearInterval(heartbeat);
  }
}

export { Broken };

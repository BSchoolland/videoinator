// One planner turn: the chat's own claude session (resumed turn to turn) in its own directory, sandboxed to
// web search, Read, and the tools/ commands. What it says comes back through outbox.jsonl.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LiveView } from "./live.ts";
import { post, upload, type Chat, type Media, type Message, type User } from "./site.ts";

const MODEL = process.env.PLANNER_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.PLANNER_EFFORT ?? "low";
const TIMEOUT_MS = 8 * 60_000;
const TOOLS = ["say", "show", "plan", "clip", "grab"];
const here = import.meta.dirname;
export const RUNS = process.env.RUNS ?? path.join(process.env.HOME!, "videoinator-runs");

export const chatDir = (chatId: string) => path.join(RUNS, "chats", chatId);

interface Part { kind: Message["kind"]; body: string; files?: string[] }

/** The user's messages since the planner last spoke, as the next prompt. */
function newInput(messages: Message[], user: User, first: boolean): string {
  const lastBot = messages.reduce((m, x) => (x.sender === "bot" ? x.id : m), 0);
  const lines = messages.filter((m) => m.sender === "user" && m.id > lastBot).map((m) => m.body);
  if (!lines.length) throw new Error("claimed a turn with no new user message");
  return first ? `${user.name} opened the Epic Video-inator and wrote:\n\n${lines.join("\n\n")}` : lines.join("\n\n");
}

/** Runs the turn; live gets the stream-json events as they come. Resolves with the session id. */
function claude(dir: string, prompt: string, session: { resume?: string; id?: string }, live: LiveView, log: (s: string) => void): Promise<string> {
  const args = [
    "-p", "--model", MODEL, "--effort", EFFORT,
    "--append-system-prompt", fs.readFileSync(path.join(here, "prompts/PLANNER.md"), "utf8").replace("{TODAY}", new Date().toDateString()),
    "--tools", "WebSearch,WebFetch,Read,Bash",
    "--allowedTools", "WebSearch", "WebFetch", "Read", ...TOOLS.map((t) => `Bash(./${t}:*)`),
    "--permission-mode", "dontAsk", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(session.resume ? ["--resume", session.resume] : ["--session-id", session.id!]),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    const logFile = fs.createWriteStream(path.join(dir, "sessions.jsonl"), { flags: "a" });
    let buf = "", err = "", result: any = null;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`planner timed out after ${TIMEOUT_MS / 60000} min`)); }, TIMEOUT_MS);
    const onLine = (l: string) => {
      let e: any;
      try { e = JSON.parse(l); } catch { return; }
      if (e.type !== "stream_event") logFile.write(l + "\n");
      if (e.type === "result") result = e;
      else live.line(e);
    };
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      logFile.end();
      if (!result) return reject(new Error(`planner exited ${code} without a result: ${err.trim().slice(-400)}`));
      if (result.is_error) return reject(new Error(`planner error: ${String(result.result ?? result.subtype).slice(0, 400)}`));
      log(`planner turn: ${result.num_turns} steps, ${(result.duration_ms / 1000).toFixed(0)}s, session ${result.session_id}`);
      resolve(String(result.session_id));
    });
    child.stdin.end(prompt);
  });
}

export async function runTurn(t: { chat: Chat; messages: Message[]; user: User }, log: (s: string) => void): Promise<void> {
  const dir = chatDir(t.chat.id);
  fs.mkdirSync(path.join(dir, "refs"), { recursive: true });
  for (const tool of TOOLS) {
    const dst = path.join(dir, tool);
    if (!fs.existsSync(dst)) fs.symlinkSync(path.join(here, "tools", tool), dst);
  }
  const outbox = path.join(dir, "outbox.jsonl");
  fs.rmSync(outbox, { force: true });
  const first = !t.chat.session_id;
  const prompt = newInput(t.messages, t.user, first);

  // each bubble goes up the moment the planner writes it, in order
  let sent = 0, flushing: Promise<void> = Promise.resolve();
  // a failed flush was already logged by its caller; the next one retries from the same bubble
  const flush = () => (flushing = flushing.catch(() => {}).then(async () => {
    if (!fs.existsSync(outbox)) return;
    const lines = fs.readFileSync(outbox, "utf8").split("\n").filter(Boolean);
    for (; sent < lines.length; sent++) {
      const p: Part = JSON.parse(lines[sent]);
      const media: Media[] = [];
      for (const f of p.files ?? []) {
        const ext = path.extname(f).slice(1);
        const { url } = await upload<{ url: string }>(`/media?ext=${ext}`, path.join(dir, f));
        media.push({ url, type: ext === "mp4" ? "video" : "image" });
      }
      await post(`/chats/${t.chat.id}/say`, { parts: [{ kind: p.kind, body: p.body, media }] });
    }
  }));
  const timer = setInterval(() => flush().catch((e) => log(`bubble failed: ${e.message}`)), 500);

  // steps and the streaming draft go up at most every 200 ms; a draft never posts after its bubble has landed
  let pending: { steps?: unknown; draft?: string } = {}, posting = false;
  const pushLive = async () => {
    if (posting || (!pending.steps && pending.draft === undefined)) return;
    posting = true;
    const body = pending; pending = {};
    await post(`/chats/${t.chat.id}/live`, body).catch((e) => log(`live update failed: ${e.message}`));
    posting = false;
  };
  const liveTimer = setInterval(pushLive, 200);
  const live = new LiveView((v) => { pending = { ...pending, ...v }; });
  let session: string;
  try {
    session = await claude(dir, prompt, first ? { id: randomUUID() } : { resume: t.chat.session_id! }, live, log);
  } finally {
    clearInterval(timer);
    clearInterval(liveTimer);
  }
  await flush();
  if (!sent) throw new Error("the planner finished its turn without saying anything");
  await post(`/chats/${t.chat.id}/reply`, { parts: [], session });
}

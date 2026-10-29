// The homeserver worker: announces access requests to Ben, answers planner turns, makes videos.
// Usage: node worker/worker.ts   (SITE, WORKER_TOKEN, BEN_CHANNEL from the env, worker/.env or ~/.config/videoinator/env)
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Broken, makeVideo } from "./make.ts";
import { runTurn } from "./planner.ts";
import { get, post, SITE, type Chat, type Job, type Message, type Request, type User } from "./site.ts";

const TURN_SLOTS = Number(process.env.TURN_SLOTS ?? 3);
const JOB_SLOTS = Number(process.env.JOB_SLOTS ?? 2);
/** Only one worker announces access requests (a second, temporary worker sets this to 0). */
const ANNOUNCE = process.env.ANNOUNCE_REQUESTS !== "0";
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (tag: string, s: string) => console.log(`${stamp()} [${tag}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const run = promisify(execFile);

// ---------------------------------------------------------------- access requests
const REPORT = path.join(os.homedir(), "Projects/benbot/scripts/report");
const THREAD = process.env.BEN_CHANNEL;
if (!THREAD) throw new Error("BEN_CHANNEL (Ben's Video-inator thread) must be set");

/** Everything Ben should hear goes to BenBot's conductor, which decides how to tell him. */
const tellBenBot = (text: string) => run(REPORT, ["--from", "videoinator", text]);

/** A request goes to BenBot's conductor, which decides what to tell Ben and asks him in his thread. */
export const requestReport = (r: Request) => `Epic Video-inator access request (benbot.si): ${r.name} <${r.email}>, request id ${r.id}.
Their video idea: ${r.idea ? `"${r.idea}"` : "(none given)"}
Message Ben about it in thread ${THREAD}: who this is if you know them (TEAM/, your memory, the email domain), whether you'd approve, and how many generations you'd give (default 5, all time). He answers there; the session in that thread approves with \`node ~/Projects/videoinator/worker/approve.ts approve ${r.id} <n>\` or \`deny ${r.id}\`.`;

/** Ben's standing approvals: email -> generations (~/.config/videoinator/auto-approve.json), read fresh each time. */
const AUTO_APPROVE = path.join(os.homedir(), ".config/videoinator/auto-approve.json");
const autoApproval = (email: string): number | undefined => {
  if (!fs.existsSync(AUTO_APPROVE)) return undefined;
  const rules: Record<string, number> = JSON.parse(fs.readFileSync(AUTO_APPROVE, "utf8"));
  return rules[email.trim().toLowerCase()];
};

async function announceRequests() {
  for (const r of (await get<Request[]>("/requests")) ?? []) {
    const n = autoApproval(r.email);
    if (n) {
      await post(`/requests/${r.id}/approve`, { credits: n });
      await tellBenBot(`Epic Video-inator: auto-approved ${r.name} <${r.email}> with ${n} generations (Ben's standing rule); their welcome email is sent. Idea: ${r.idea ? `"${r.idea}"` : "(none)"}. Just let Ben know in thread ${THREAD}.`);
    } else await tellBenBot(requestReport(r));
    await post(`/requests/${r.id}/announced`, {});
    log("requests", `reported ${r.id} (${r.email}) to BenBot`);
  }
}

// ---------------------------------------------------------------- ratings
interface NewRating { job_id: string; voter: string; owner: number; stars: number; text: string; created_at: number; title: string; maker: string }
async function announceRatings() {
  for (const r of (await get<NewRating[]>("/ratings/new")) ?? []) {
    const who = r.owner ? `${r.maker} (who made it)` : `a viewer (made by ${r.maker})`;
    await tellBenBot(`Epic Video-inator rating: "${r.title}" (job ${r.job_id}) got ${r.stars}/5 stars from ${who}. ${r.text ? `Feedback: "${r.text}"` : "No comment."} Tell Ben in thread ${THREAD}.`);
    await post("/ratings/announced", { job: r.job_id, voter: r.voter, at: r.created_at });
    log("ratings", `reported ${r.stars}★ on ${r.job_id}`);
  }
}

// ---------------------------------------------------------------- planner turns
let turns = 0;
async function nextTurn() {
  const t = await get<{ chat: Chat; messages: Message[]; user: User }>("/turns/next");
  if (!t) return false;
  turns++;
  const tag = `chat ${t.chat.id}`;
  log(tag, `turn for ${t.user.name}`);
  runTurn(t, (s) => log(tag, s))
    .catch(async (e) => {
      log(tag, `TURN FAILED: ${msg(e)}`);
      await post(`/chats/${t.chat.id}/reply`, { parts: [{ kind: "text", body: "My brain blue-screened for a second there. Say that again?" }], session: t.chat.session_id ?? "" })
        .catch((x) => log(tag, `could not post the error reply: ${msg(x)}`));
      await tellBenBot(`Epic Video-inator: a planner turn failed for ${t.user.name} (chat ${t.chat.id}); they were shown "My brain blue-screened for a second there. Say that again?". Error: ${msg(e).slice(0, 500)}. Tell Ben in thread ${THREAD}.`)
        .catch((x) => log(tag, `could not tell Ben: ${msg(x)}`));
    })
    .finally(() => turns--);
  return true;
}

// ---------------------------------------------------------------- videos
let making = 0;
async function nextJob() {
  const j = await get<{ job: Job; chat: Chat; messages: Message[]; user: User }>("/jobs/next");
  if (!j) return false;
  making++;
  const tag = `job ${j.job.id}`;
  const ac = new AbortController();
  log(tag, `video for ${j.user.name} (attempt ${j.job.attempts})`);
  makeVideo(j, (s) => log(tag, s), ac.signal)
    .then(() => tellBenBot(`Epic Video-inator: ${j.user.name}'s video is done and they've been emailed (job ${j.job.id}, files in ~/videoinator-runs/jobs/${j.job.id}, share cut out/cycle-2-share.mp4, critique critique-c1.md). Tell Ben in thread ${THREAD}; watch it first if you can.`))
    .catch(async (e) => {
      const why = e instanceof Broken ? e.message : `something broke: ${msg(e)}`;
      log(tag, `FAILED: ${why}`);
      await post(`/jobs/${j.job.id}/fail`, { error: why }).catch((x) => log(tag, `could not fail the job: ${msg(x)}`));
      await tellBenBot(`Epic Video-inator: ${j.user.name}'s video FAILED (job ${j.job.id}, their credit was refunded and they were emailed): ${why.slice(0, 600)}. Run dir ~/videoinator-runs/jobs/${j.job.id}. Tell Ben in thread ${THREAD}.`)
        .catch((x) => log(tag, `could not tell Ben: ${msg(x)}`));
    })
    .finally(() => { making--; });
  return true;
}

log("worker", `polling ${SITE}: ${TURN_SLOTS} planner slots, ${JOB_SLOTS} video slots${ANNOUNCE ? "" : ", not announcing requests"}`);
let lastRequests = 0;
for (;;) {
  try {
    if (ANNOUNCE && Date.now() - lastRequests > 15_000) { lastRequests = Date.now(); await announceRequests(); await announceRatings(); }
    while (turns < TURN_SLOTS && (await nextTurn()));
    while (making < JOB_SLOTS && (await nextJob()));
  } catch (e) {
    log("worker", `poll failed: ${msg(e)}`);
  }
  await sleep(2000);
}

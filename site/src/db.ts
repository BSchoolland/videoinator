import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { DB_PATH, JOB_LEASE_MS, TURN_LEASE_MS } from "./config.ts";

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, idea TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', announced INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, claimed_at INTEGER, claimed_upto INTEGER, session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id),
  sender TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), plan_msg_id INTEGER NOT NULL, parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT '', pct REAL NOT NULL DEFAULT 0,
  eta_at INTEGER, claimed_at INTEGER, heartbeat_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  video TEXT, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS ratings (
  job_id TEXT NOT NULL REFERENCES jobs(id), voter TEXT NOT NULL, owner INTEGER NOT NULL, stars INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '', announced INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, voter)
);
`);
// live: what the planner is doing right now and the bubble it's mid-way through writing, while it's thinking
const addColumn = (table: string, col: string) => {
  const name = col.split(" ")[0];
  if (!(db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
};
for (const col of ["steps TEXT NOT NULL DEFAULT '[]'", "draft TEXT NOT NULL DEFAULT ''"]) addColumn("chats", col);
// the idea they gave when asking for access, waiting in the box on their first visit
addColumn("users", "idea TEXT NOT NULL DEFAULT ''");
// the still a shared video's link previews with
addColumn("jobs", "poster TEXT");
// a chat makes one video, then any number of edits of it: each edit is a job whose parent is the version it changes
if (((db.query("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get() as { sql: string }).sql).includes("chat_id TEXT NOT NULL UNIQUE")) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.exec(`CREATE TABLE jobs_new (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), plan_msg_id INTEGER NOT NULL, parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT '', pct REAL NOT NULL DEFAULT 0,
      eta_at INTEGER, claimed_at INTEGER, heartbeat_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      video TEXT, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, poster TEXT)`);
    db.exec(`INSERT INTO jobs_new (id, chat_id, plan_msg_id, status, stage, pct, eta_at, claimed_at, heartbeat_at, attempts, video, error, created_at, finished_at, poster)
      SELECT id, chat_id, plan_msg_id, status, stage, pct, eta_at, claimed_at, heartbeat_at, attempts, video, error, created_at, finished_at, poster FROM jobs`);
    db.exec("DROP TABLE jobs");
    db.exec("ALTER TABLE jobs_new RENAME TO jobs");
  })();
  db.exec("PRAGMA foreign_keys = ON");
}
db.exec("CREATE INDEX IF NOT EXISTS jobs_chat ON jobs(chat_id, created_at)");
db.exec(`UPDATE users SET idea = COALESCE((SELECT r.idea FROM requests r WHERE lower(r.email) = lower(users.email)
  AND r.status = 'approved' AND r.idea != '' ORDER BY r.created_at DESC LIMIT 1), '') WHERE idea = ''`);

export const newId = (bytes = 8) => randomBytes(bytes).toString("hex");
const now = () => Date.now();

/** awaiting: the planner owes a reply. thinking: the worker is writing it. idle: the user's turn.
 *  queued/cooking/done/failed: the video after Generate. */
export type ChatStatus = "awaiting" | "thinking" | "idle" | "queued" | "cooking" | "done" | "failed";
export interface Media { url: string; type: "video" | "image"; caption?: string }
export interface Request { id: string; name: string; email: string; idea: string; status: string; announced: number; created_at: number }
export interface User { id: string; name: string; email: string; token: string; credits: number; used: number; idea: string }
export interface Chat { id: string; user_id: string; status: ChatStatus; claimed_at: number | null; claimed_upto: number | null; session_id: string | null; created_at: number; steps: string; draft: string }
export interface Message { id: number; chat_id: string; sender: "user" | "bot"; kind: "text" | "media" | "plan" | "edit"; body: string; media: Media[]; created_at: number }
export interface Job { id: string; chat_id: string; plan_msg_id: number; parent_id: string | null; status: string; stage: string; pct: number; eta_at: number | null; claimed_at: number | null; heartbeat_at: number | null; attempts: number; video: string | null; poster: string | null; error: string | null; created_at: number; finished_at: number | null }

const one = <T>(sql: string, ...p: any[]) => (db.query(sql).get(...p) as T | null) ?? null;
const all = <T>(sql: string, ...p: any[]) => db.query(sql).all(...p) as T[];
const run = (sql: string, ...p: any[]) => db.query(sql).run(...p);

// ---------------------------------------------------------------- access requests
export function addRequest(name: string, email: string, idea: string): Request {
  const id = newId(4);
  run("INSERT INTO requests (id, name, email, idea, created_at) VALUES (?, ?, ?, ?, ?)", id, name, email, idea, now());
  return one<Request>("SELECT * FROM requests WHERE id = ?", id)!;
}
export const request = (id: string) => one<Request>("SELECT * FROM requests WHERE id = ?", id);
export const unannouncedRequests = () => all<Request>("SELECT * FROM requests WHERE announced = 0 ORDER BY created_at");
export const markAnnounced = (id: string) => run("UPDATE requests SET announced = 1 WHERE id = ?", id);
export const pendingRequests = () => all<Request>("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at");

/** Approving makes (or tops up) the user and returns them; the caller emails the link. */
export function approve(reqId: string, credits: number): User {
  const r = request(reqId);
  if (!r) throw new Error(`no request ${reqId}`);
  if (r.status !== "pending") throw new Error(`request ${reqId} is already ${r.status}`);
  return db.transaction(() => {
    run("UPDATE requests SET status = 'approved', decided_at = ? WHERE id = ?", now(), reqId);
    const existing = userByEmail(r.email);
    if (existing) {
      run("UPDATE users SET credits = credits + ?, idea = CASE WHEN ? != '' THEN ? ELSE idea END WHERE id = ?", credits, r.idea, r.idea, existing.id);
      return userById(existing.id)!;
    }
    const id = newId(6);
    run("INSERT INTO users (id, name, email, token, credits, idea, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, r.name, r.email, newId(18), credits, r.idea, now());
    return userById(id)!;
  })();
}
export function deny(reqId: string) {
  const r = request(reqId);
  if (!r) throw new Error(`no request ${reqId}`);
  if (r.status !== "pending") throw new Error(`request ${reqId} is already ${r.status}`);
  run("UPDATE requests SET status = 'denied', decided_at = ? WHERE id = ?", now(), reqId);
}

// ---------------------------------------------------------------- users
export const userByToken = (t: string) => one<User>("SELECT * FROM users WHERE token = ?", t);
export const userById = (id: string) => one<User>("SELECT * FROM users WHERE id = ?", id);
export const userByEmail = (e: string) => one<User>("SELECT * FROM users WHERE lower(email) = lower(?)", e);
export const users = () => all<User>("SELECT * FROM users ORDER BY created_at");
export const setCredits = (id: string, credits: number) => run("UPDATE users SET credits = ? WHERE id = ?", credits, id);

// ---------------------------------------------------------------- chats and messages
const rowToMessage = (m: any): Message => ({ ...m, media: JSON.parse(m.media) });

export function newChat(userId: string, text: string): Chat {
  const id = newId(6);
  db.transaction(() => {
    run("INSERT INTO chats (id, user_id, status, created_at) VALUES (?, ?, 'awaiting', ?)", id, userId, now());
    addMessage(id, "user", "text", text);
  })();
  return chat(id)!;
}
export const chat = (id: string) => one<Chat>("SELECT * FROM chats WHERE id = ?", id);
export const chatsOf = (userId: string) => all<Chat>("SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC", userId);
export const messages = (chatId: string, after = 0) =>
  all<any>("SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id", chatId, after).map(rowToMessage);
export const message = (id: number) => { const m = one<any>("SELECT * FROM messages WHERE id = ?", id); return m && rowToMessage(m); };

export function addMessage(chatId: string, sender: Message["sender"], kind: Message["kind"], body: string, media: Media[] = []): number {
  return Number(run("INSERT INTO messages (chat_id, sender, kind, body, media, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    chatId, sender, kind, body, JSON.stringify(media), now()).lastInsertRowid);
}

/** A user message: the planner owes a reply (if it's mid-reply, it picks this up when it finishes). */
export function userSays(c: Chat, text: string) {
  db.transaction(() => {
    addMessage(c.id, "user", "text", text);
    if (c.status === "idle" || c.status === "done") run("UPDATE chats SET status = 'awaiting' WHERE id = ?", c.id);
  })();
}

/** The oldest chat owed a reply, claimed: its status goes to thinking, remembering how far it had read. */
/** A turn, plus the chat's newest finished version and how many there are, when the chat is past its first video. */
export function claimTurn(): { chat: Chat; messages: Message[]; user: User; video: Job | null; versions: number } | null {
  return db.transaction(() => {
    run("UPDATE chats SET status = 'awaiting' WHERE status = 'thinking' AND claimed_at < ?", now() - TURN_LEASE_MS);
    const c = one<Chat>("SELECT * FROM chats WHERE status = 'awaiting' ORDER BY created_at LIMIT 1");
    if (!c) return null;
    const upto = one<{ m: number }>("SELECT max(id) AS m FROM messages WHERE chat_id = ?", c.id)!.m;
    run("UPDATE chats SET status = 'thinking', claimed_at = ?, claimed_upto = ?, steps = '[]', draft = '' WHERE id = ?", now(), upto, c.id);
    const vs = versions(c.id);
    return { chat: chat(c.id)!, messages: messages(c.id), user: userById(c.user_id)!, video: vs.at(-1) ?? null, versions: vs.length };
  })();
}

type Part = { kind: Message["kind"]; body: string; media?: Media[] };

/** A bubble from the planner mid-turn: shown right away (replacing the draft it was streaming), the turn stays open. */
export function botSays(chatId: string, parts: Part[]) {
  db.transaction(() => {
    const c = chat(chatId);
    if (!c || !["thinking", "queued", "cooking"].includes(c.status)) throw new Error(`chat ${chatId} is not waiting on the planner (it is ${c?.status})`);
    for (const p of parts) addMessage(chatId, "bot", p.kind, p.body, p.media ?? []);
    run("UPDATE chats SET draft = '' WHERE id = ?", chatId);
  })();
}

export interface Step { text: string; at: number }
/** The planner's live state: its steps so far and the bubble it's writing. */
export function live(chatId: string, steps: Step[] | undefined, draft: string | undefined) {
  const c = chat(chatId);
  if (!c || c.status !== "thinking") return; // they've moved on (hit Generate): nothing live to show
  if (steps) run("UPDATE chats SET steps = ? WHERE id = ?", JSON.stringify(steps), chatId);
  if (draft !== undefined) run("UPDATE chats SET draft = ? WHERE id = ?", draft, chatId);
}

/** The planner's turn ends (with any last bubbles); if the user said more meanwhile, the chat is owed another reply. */
export function botReplies(chatId: string, parts: Part[], sessionId: string) {
  db.transaction(() => {
    const c = chat(chatId);
    if (!c) throw new Error(`no chat ${chatId}`);
    // they hit Generate on a plan while the planner was still finishing its turn: the turn just ends
    if (["queued", "cooking", "done", "failed"].includes(c.status)) {
      for (const p of parts) addMessage(chatId, "bot", p.kind, p.body, p.media ?? []);
      run("UPDATE chats SET session_id = COALESCE(NULLIF(?, ''), session_id), claimed_at = NULL, steps = '[]', draft = '' WHERE id = ?", sessionId, chatId);
      return;
    }
    if (c.status !== "thinking") throw new Error(`chat ${chatId} is not waiting on the planner (it is ${c.status})`);
    for (const p of parts) addMessage(chatId, "bot", p.kind, p.body, p.media ?? []);
    const newer = one<{ n: number }>("SELECT count(*) AS n FROM messages WHERE chat_id = ? AND sender = 'user' AND id > ?", chatId, c.claimed_upto ?? 0)!.n;
    run("UPDATE chats SET status = ?, session_id = COALESCE(NULLIF(?, ''), session_id), claimed_at = NULL, steps = '[]', draft = '' WHERE id = ?", newer ? "awaiting" : "idle", sessionId, chatId);
  })();
}

// ---------------------------------------------------------------- jobs
/** The chat's newest job: its video, or the edit in progress. */
export const jobOf = (chatId: string) => one<Job>("SELECT * FROM jobs WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1", chatId);
/** Every finished version of the chat's video, oldest first. */
export const versions = (chatId: string) => all<Job>("SELECT * FROM jobs WHERE chat_id = ? AND status = 'done' ORDER BY created_at", chatId);
export const job = (id: string) => one<Job>("SELECT * FROM jobs WHERE id = ?", id);

/** Generate: spends one credit and queues the video. */
export function generate(c: Chat, planMsgId: number): Job {
  return db.transaction(() => {
    const u = userById(c.user_id)!;
    if (u.used >= u.credits) throw new Error("no generations left");
    const plan = message(planMsgId);
    if (!plan || plan.chat_id !== c.id || (plan.kind !== "plan" && plan.kind !== "edit")) throw new Error("that isn't a plan in this chat");
    const latest = jobOf(c.id), base = versions(c.id).at(-1);
    if (latest && (latest.status === "queued" || latest.status === "running")) throw new Error("this video is already cooking");
    if (plan.kind === "plan" && latest) throw new Error("this chat already made its video; ask for edits instead");
    if (plan.kind === "edit" && !base) throw new Error("there's no finished video to edit yet");
    run("UPDATE users SET used = used + 1 WHERE id = ?", u.id);
    const id = newId(6);
    run("INSERT INTO jobs (id, chat_id, plan_msg_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?)", id, c.id, planMsgId, plan.kind === "edit" ? base!.id : null, now());
    run("UPDATE chats SET status = 'queued' WHERE id = ?", c.id);
    return job(id)!;
  })();
}

export function claimJob(): Job | null {
  return db.transaction(() => {
    run("UPDATE jobs SET status = 'queued' WHERE status = 'running' AND heartbeat_at < ?", now() - JOB_LEASE_MS);
    // one video per person at a time: someone's second video waits for their first, others' go ahead of it
    const j = one<Job>(`SELECT j.* FROM jobs j JOIN chats c ON c.id = j.chat_id WHERE j.status = 'queued'
      AND c.user_id NOT IN (SELECT c2.user_id FROM jobs j2 JOIN chats c2 ON c2.id = j2.chat_id WHERE j2.status = 'running')
      ORDER BY j.created_at LIMIT 1`);
    if (!j) return null;
    run("UPDATE jobs SET status = 'running', claimed_at = ?, heartbeat_at = ?, attempts = attempts + 1 WHERE id = ?", now(), now(), j.id);
    run("UPDATE chats SET status = 'cooking' WHERE id = ?", j.chat_id);
    return job(j.id)!;
  })();
}

export function progress(id: string, stage: string, pct: number, etaAt: number | null) {
  const j = job(id);
  if (!j || j.status !== "running") throw new Error(`job ${id} is not running (it is ${j?.status})`);
  run("UPDATE jobs SET stage = ?, pct = ?, eta_at = ?, heartbeat_at = ? WHERE id = ?", stage, pct, etaAt, now(), id);
}

export function finishJob(id: string, video: string, poster: string | null) {
  db.transaction(() => {
    const j = job(id)!;
    run("UPDATE jobs SET status = 'done', video = ?, poster = ?, pct = 1, finished_at = ? WHERE id = ?", video, poster, now(), id);
    run("UPDATE chats SET status = 'done' WHERE id = ?", j.chat_id);
  })();
}

/** A failed video gives its credit back. */
export function failJob(id: string, error: string) {
  db.transaction(() => {
    const j = job(id)!;
    run("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", error, now(), id);
    if (j.parent_id) {
      addMessage(j.chat_id, "bot", "text", "That edit blew up while cooking. Ben's been told, you got your generation back, and your last version is still right here.");
      run("UPDATE chats SET status = 'done' WHERE id = ?", j.chat_id);
    } else run("UPDATE chats SET status = 'failed' WHERE id = ?", j.chat_id);
    run("UPDATE users SET used = used - 1 WHERE id = (SELECT user_id FROM chats WHERE id = ?)", j.chat_id);
  })();
}

export const setPoster = (id: string, poster: string) => run("UPDATE jobs SET poster = ? WHERE id = ?", poster, id);
/** A finished video's public page: the title is the plan's first line. */
export function shared(jobId: string): { video: string; poster: string | null; title: string } | null {
  const j = job(jobId);
  if (!j || j.status !== "done" || !j.video) return null;
  let root = j;
  while (root.parent_id) root = job(root.parent_id)!;
  const plan = message(root.plan_msg_id);
  const title = (plan?.body.split("\n").find((l) => l.trim()) ?? "An epic video").replace(/^[#*\s]+|[*\s]+$/g, "").slice(0, 90);
  return { video: j.video, poster: j.poster, title };
}

// ---------------------------------------------------------------- ratings
/** voter: "u:<user id>" when signed in, else "v:<browser cookie>"; owner: the voter made the video. */
export interface Rating { job_id: string; voter: string; owner: number; stars: number; text: string; created_at: number }
export function rate(jobId: string, voter: string, owner: boolean, stars: number, text: string) {
  run(`INSERT INTO ratings (job_id, voter, owner, stars, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, voter) DO UPDATE SET stars = excluded.stars, text = excluded.text, announced = 0, created_at = excluded.created_at`,
    jobId, voter, owner ? 1 : 0, stars, text, now());
}
export const ratingBy = (jobId: string, voter: string) =>
  one<Rating>("SELECT * FROM ratings WHERE job_id = ? AND voter = ?", jobId, voter);
export const unannouncedRatings = () => all<Rating>("SELECT * FROM ratings WHERE announced = 0 ORDER BY created_at");
export const markRatingAnnounced = (jobId: string, voter: string, at: number) =>
  run("UPDATE ratings SET announced = 1 WHERE job_id = ? AND voter = ? AND created_at = ?", jobId, voter, at);

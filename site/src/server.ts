import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { DEFAULT_CREDITS, DEV, MEDIA_DIR, PORT, WORKER_TOKEN } from "./config.ts";
import * as D from "./db.ts";
import * as E from "./emails.ts";
import { announceMailMode } from "./mail.ts";

const PUBLIC = join(import.meta.dir, "..", "public");

class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }
const bad = (m: string) => new HttpError(400, m);
const json = (d: unknown, status = 200) => Response.json(d, { status });

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4", ".webm": "video/webm", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json",
};

/** Files with Range support, which video seeking needs. */
function file(path: string, req: Request): Response {
  if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
  const size = statSync(path).size;
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (!m) return new Response(Bun.file(path), { headers: { "content-type": type, "accept-ranges": "bytes" } });
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(Bun.file(path).slice(start, end + 1), {
    status: 206,
    headers: { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

function under(root: string, rel: string): string {
  const p = normalize(join(root, rel));
  if (!p.startsWith(root)) throw new HttpError(404, "not found");
  return p;
}

const cookie = (req: Request, k: string) =>
  (req.headers.get("cookie") ?? "").split(";").map((s) => s.trim().split("=")).find(([n]) => n === k)?.[1];

function me(req: Request): D.User {
  const t = cookie(req, "vi");
  const u = t ? D.userByToken(t) : null;
  if (!u) throw new HttpError(401, "not signed in");
  return u;
}

function myChat(req: Request, id: string): { u: D.User; c: D.Chat } {
  const u = me(req);
  const c = D.chat(id);
  if (!c || c.user_id !== u.id) throw new HttpError(404, "no such chat");
  return { u, c };
}

function worker(req: Request) {
  if (req.headers.get("x-worker-token") !== WORKER_TOKEN) throw new HttpError(401, "bad worker token");
}

const body = async (req: Request) => { try { return (await req.json()) as any; } catch { throw bad("expected a JSON body"); } };
const str = (v: unknown, name: string, max: number, required = true) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} is too long (max ${max})`);
  return s;
};

const chatView = (c: D.Chat, after = 0) => {
  const j = D.jobOf(c.id);
  return {
    id: c.id, status: c.status, messages: D.messages(c.id, after),
    live: c.status === "thinking" ? { steps: JSON.parse(c.steps), draft: c.draft } : null,
    job: j && { status: j.status, stage: j.stage, pct: j.pct, eta_at: j.eta_at, video: j.video && `/media/${j.video}`, plan_msg_id: j.plan_msg_id },
  };
};

const recentRequests = new Map<string, number[]>();
function rateLimit(ip: string) {
  const t = Date.now();
  const hits = (recentRequests.get(ip) ?? []).filter((x) => t - x < 3600_000);
  if (hits.length >= 5) throw new HttpError(429, "slow down");
  recentRequests.set(ip, [...hits, t]);
}

type Handler = (req: Request, p: Record<string, string>, ip: string) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);

// ---------------------------------------------------------------- pages
route("GET", "/healthz", () => new Response("ok"));
route("GET", "/in/:token", (req, p) => {
  if (!D.userByToken(p.token)) return Response.redirect("/", 303);
  const chat = new URL(req.url).searchParams.get("chat");
  return new Response(null, {
    status: 303,
    headers: { location: chat ? `/#chat/${chat}` : "/", "set-cookie": `vi=${p.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${DEV ? "" : "; Secure"}` },
  });
});
route("GET", "/media/:file", (req, p) => file(under(MEDIA_DIR, p.file), req));

// ---------------------------------------------------------------- the public API
route("POST", "/api/requests", async (req, _p, ip) => {
  rateLimit(ip);
  const b = await body(req);
  const email = str(b.email, "email", 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("that email doesn't look right");
  // someone already in who asks again gets their link, not a second request
  const u = D.userByEmail(email);
  if (u) { await E.signIn(u); return json({ ok: true, already: true }); }
  D.addRequest(str(b.name, "name", 80), email, str(b.idea, "idea", 600, false));
  return json({ ok: true });
});

route("POST", "/api/login", async (req, _p, ip) => {
  rateLimit(ip);
  const u = D.userByEmail(str((await body(req)).email, "email", 200));
  // the same answer either way, so this can't be used to find out who's in
  if (u) await E.signIn(u);
  return json({ ok: true });
});

route("GET", "/api/me", (req) => {
  const u = me(req);
  return json({ name: u.name, left: u.credits - u.used, chats: D.chatsOf(u.id).map((c) => ({ id: c.id, status: c.status, first: D.messages(c.id)[0]?.body ?? "" })) });
});

route("POST", "/api/chats", async (req) => {
  const u = me(req);
  const c = D.newChat(u.id, str((await body(req)).text, "text", 2000));
  return json(chatView(c));
});

route("GET", "/api/chats/:id", (req, p) => {
  const { c } = myChat(req, p.id);
  return json(chatView(c, Number(new URL(req.url).searchParams.get("after") ?? 0)));
});

route("POST", "/api/chats/:id/messages", async (req, p) => {
  const { c } = myChat(req, p.id);
  if (!["awaiting", "thinking", "idle"].includes(c.status)) throw bad("this video is already being made");
  D.userSays(c, str((await body(req)).text, "text", 2000));
  return json({ ok: true });
});

route("POST", "/api/chats/:id/generate", async (req, p) => {
  const { c } = myChat(req, p.id);
  try { D.generate(c, Number((await body(req)).plan)); } catch (e) { throw bad((e as Error).message); }
  return json(chatView(D.chat(c.id)!));
});

// ---------------------------------------------------------------- the worker (homeserver) and approvals
route("GET", "/api/worker/requests", (req) => { worker(req); return json(D.unannouncedRequests()); });
route("POST", "/api/worker/requests/:id/announced", (req, p) => { worker(req); D.markAnnounced(p.id); return json({ ok: true }); });
route("GET", "/api/worker/pending", (req) => { worker(req); return json({ requests: D.pendingRequests(), users: D.users() }); });

route("POST", "/api/worker/requests/:id/approve", async (req, p) => {
  worker(req);
  const n = Number((await body(req)).credits ?? DEFAULT_CREDITS);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw bad("credits must be 1..100");
  const u = D.approve(p.id, n);
  await E.welcome(u);
  return json({ ok: true, user: { id: u.id, email: u.email, credits: u.credits, used: u.used } });
});
route("POST", "/api/worker/requests/:id/deny", (req, p) => { worker(req); D.deny(p.id); return json({ ok: true }); });
route("POST", "/api/worker/users/:id/credits", async (req, p) => {
  worker(req);
  const n = Number((await body(req)).credits);
  if (!Number.isInteger(n) || n < 0) throw bad("credits must be a whole number");
  D.setCredits(p.id, n);
  return json({ ok: true });
});

route("GET", "/api/worker/turns/next", (req) => {
  worker(req);
  const t = D.claimTurn();
  return t ? json(t) : new Response(null, { status: 204 });
});
const parts = (b: any) => {
  if (!Array.isArray(b.parts)) throw bad("parts must be an array");
  for (const x of b.parts) if (!["text", "media", "plan"].includes(x.kind)) throw bad(`unknown part kind ${x.kind}`);
  return b.parts;
};
route("POST", "/api/worker/chats/:id/say", async (req, p) => {
  worker(req);
  try { D.botSays(p.id, parts(await body(req))); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, (e as Error).message); }
  return json({ ok: true });
});
route("POST", "/api/worker/chats/:id/live", async (req, p) => {
  worker(req);
  const b = await body(req);
  const steps = b.steps === undefined ? undefined : (b.steps as unknown[]).slice(-30).map((x: any) => ({ text: str(x.text, "step", 300), at: Number(x.at) || Date.now() }));
  const draft = b.draft === undefined ? undefined : str(b.draft, "draft", 4000, false);
  try { D.live(p.id, steps, draft); } catch (e) { throw new HttpError(409, (e as Error).message); }
  return json({ ok: true });
});
route("POST", "/api/worker/chats/:id/reply", async (req, p) => {
  worker(req);
  const b = await body(req);
  try { D.botReplies(p.id, parts(b), str(b.session, "session", 100)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, (e as Error).message); }
  return json({ ok: true });
});
route("POST", "/api/worker/media", async (req) => {
  worker(req);
  const ext = new URL(req.url).searchParams.get("ext") ?? "";
  if (!/^(mp4|webm|jpg|png|webp)$/.test(ext)) throw bad("ext must be mp4, webm, jpg, png or webp");
  const name = `${D.newId(10)}.${ext}`;
  writeFileSync(join(MEDIA_DIR, name), new Uint8Array(await req.arrayBuffer()));
  return json({ url: `/media/${name}` });
});

route("GET", "/api/worker/jobs/next", async (req) => {
  worker(req);
  const j = D.claimJob();
  if (!j) return new Response(null, { status: 204 });
  const c = D.chat(j.chat_id)!;
  // once per video: a reclaimed job (worker restart) doesn't email again
  if (j.attempts === 1) await E.videoStarted(D.userById(c.user_id)!, c.id);
  return json({ job: j, chat: c, messages: D.messages(c.id), user: D.userById(c.user_id) });
});
route("POST", "/api/worker/jobs/:id/progress", async (req, p) => {
  worker(req);
  const b = await body(req);
  try { D.progress(p.id, str(b.stage, "stage", 200), Number(b.pct) || 0, b.eta_at ? Number(b.eta_at) : null); }
  catch (e) { throw new HttpError(409, (e as Error).message); }
  return json({ ok: true });
});
route("POST", "/api/worker/jobs/:id/done", async (req, p) => {
  worker(req);
  const j = D.job(p.id);
  if (!j || j.status !== "running") throw new HttpError(409, `job ${p.id} is not running`);
  const name = `${D.newId(10)}.mp4`;
  writeFileSync(join(MEDIA_DIR, name), new Uint8Array(await req.arrayBuffer()));
  D.finishJob(p.id, name);
  const c = D.chat(j.chat_id)!;
  await E.videoReady(D.userById(c.user_id)!, c.id);
  return json({ ok: true, video: `/media/${name}` });
});
route("POST", "/api/worker/jobs/:id/fail", async (req, p) => {
  worker(req);
  const j = D.job(p.id);
  if (!j || j.status !== "running") throw new HttpError(409, `job ${p.id} is not running`);
  D.failJob(p.id, str((await body(req)).error, "error", 2000));
  const c = D.chat(j.chat_id)!;
  await E.videoFailed(D.userById(c.user_id)!, c.id);
  return json({ ok: true });
});

// ---------------------------------------------------------------- serve
announceMailMode();
Bun.serve({
  port: PORT,
  maxRequestBodySize: 200 * 1024 * 1024,
  async fetch(req, server) {
    const u = new URL(req.url);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]!.trim() ?? server.requestIP(req)?.address ?? "?";
    try {
      for (const [m, re, h] of routes) {
        const hit = req.method === m && re.exec(u.pathname);
        if (hit) return await h(req, hit.groups ?? {}, ip);
      }
      if (req.method === "GET") {
        const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
        return file(under(PUBLIC, rel), req);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(`${req.method} ${u.pathname}:`, e);
      return json({ error: "something broke" }, 500);
    }
  },
});
console.log(`videoinator on :${PORT}${DEV ? " (dev)" : ""}`);

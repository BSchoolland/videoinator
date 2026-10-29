import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { DEFAULT_CREDITS, DEV, MEDIA_DIR, PORT, WORKER_TOKEN, url } from "./config.ts";
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
    versions: D.versions(c.id).map((v) => ({ id: v.id, video: `/media/${v.video}`, share: url(`/v/${v.id}`) })),
    job: j && { id: j.id, status: j.status, stage: j.stage, pct: j.pct, eta_at: j.eta_at, video: j.video && `/media/${j.video}`, share: j.status === "done" ? url(`/v/${j.id}`) : null, plan_msg_id: j.plan_msg_id },
  };
};

const recentHits = new Map<string, number[]>();
function rateLimit(ip: string, bucket = "access", perHour = 5) {
  const t = Date.now(), k = `${bucket} ${ip}`;
  const hits = (recentHits.get(k) ?? []).filter((x) => t - x < 3600_000);
  if (hits.length >= perHour) throw new HttpError(429, "slow down");
  recentHits.set(k, [...hits, t]);
}

type Handler = (req: Request, p: Record<string, string>, ip: string) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);

// ---------------------------------------------------------------- pages
route("GET", "/healthz", () => new Response("ok"));
route("GET", "/in/:token", (req, p) => {
  const owner = D.userByToken(p.token);
  if (!owner) return Response.redirect("/", 303);
  const chat = new URL(req.url).searchParams.get("chat");
  // someone already signed in as somebody else opened a forwarded link: show them the video, don't switch accounts
  const current = cookie(req, "vi");
  if (current && current !== p.token && D.userByToken(current)) {
    const j = chat ? D.versions(chat).at(-1) : null;
    return Response.redirect(j ? `/v/${j.id}` : "/", 303);
  }
  return new Response(null, {
    status: 303,
    headers: { location: chat ? `/#chat/${chat}` : "/", "set-cookie": `vi=${p.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${DEV ? "" : "; Secure"}` },
  });
});
route("GET", "/media/:file", (req, p) => file(under(MEDIA_DIR, p.file), req));

// a finished video anyone can open: plays in the page and in Discord/iMessage/Slack link previews
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
route("GET", "/v/:id", (_req, p) => {
  const v = D.shared(p.id);
  if (!v) return new Response("not found", { status: 404 });
  const page = url(`/v/${p.id}`), mp4 = url(`/media/${v.video}`), img = v.poster ? url(`/media/${v.poster}`) : url("/og.jpg");
  const t = esc(v.title);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} · Epic Video-inator</title>
<meta name="theme-color" content="#ff7ac6">
<link rel="icon" href="/benbot.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="video.other"><meta property="og:site_name" content="Epic Video-inator">
<meta property="og:url" content="${page}"><meta property="og:title" content="${t}">
<meta property="og:description" content="Made with the Epic Video-inator, the power of BenBot SI.">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1080">
<meta property="og:video" content="${mp4}"><meta property="og:video:secure_url" content="${mp4}"><meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1080"><meta property="og:video:height" content="1080">
<meta name="twitter:card" content="player"><meta name="twitter:title" content="${t}"><meta name="twitter:image" content="${img}">
<meta name="twitter:player" content="${url(`/embed/${p.id}`)}"><meta name="twitter:player:width" content="1080"><meta name="twitter:player:height" content="1080">
<meta name="twitter:player:stream" content="${mp4}"><meta name="twitter:player:stream:content_type" content="video/mp4">
<link rel="alternate" type="application/json+oembed" href="${url(`/oembed?url=${encodeURIComponent(page)}`)}" title="${t}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bungee&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css"></head><body><main id="app"><section class="screen center shared">
<h2>${t}</h2>
<video class="final" src="${mp4}" poster="${img}" controls playsinline></video>
<div class="rate" data-job="${p.id}"></div>
<a class="btn go" href="/">Make your own epic video</a>
</section><script type="module">import { mountRating } from "/rate.js"; mountRating(document.querySelector(".rate")).catch(console.error);</script></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
// the bare player Slack and X frame in their link previews
route("GET", "/embed/:id", (_req, p) => {
  const v = D.shared(p.id);
  if (!v) return new Response("not found", { status: 404 });
  const img = v.poster ? url(`/media/${v.poster}`) : url("/og.jpg");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(v.title)}</title>
<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain;display:block}</style></head>
<body><video src="${url(`/media/${v.video}`)}" poster="${img}" controls playsinline></video></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
});
route("GET", "/oembed", (req) => {
  const id = /\/v\/([^/?#]+)/.exec(new URL(req.url).searchParams.get("url") ?? "")?.[1];
  const v = id && D.shared(id);
  if (!v) return new Response("not found", { status: 404 });
  return json({
    version: "1.0", type: "video", provider_name: "Epic Video-inator", provider_url: url("/"), title: v.title,
    thumbnail_url: v.poster ? url(`/media/${v.poster}`) : url("/og.jpg"), thumbnail_width: 1080, thumbnail_height: 1080,
    width: 1080, height: 1080,
    html: `<iframe src="${url(`/embed/${id}`)}" width="1080" height="1080" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
  });
});
// stars and an optional comment on a finished video, from its maker or anyone it was shared with
function voter(req: Request, jobId: string): { id: string; owner: boolean; setCookie?: string } {
  const t = cookie(req, "vi"), u = t ? D.userByToken(t) : null;
  if (u) {
    const j = D.job(jobId);
    return { id: `u:${u.id}`, owner: !!j && D.chat(j.chat_id)?.user_id === u.id };
  }
  const v = cookie(req, "rv");
  if (v && /^[0-9a-f]{16}$/.test(v)) return { id: `v:${v}`, owner: false };
  const fresh = D.newId();
  return { id: `v:${fresh}`, owner: false, setCookie: `rv=${fresh}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${DEV ? "" : "; Secure"}` };
}
route("GET", "/api/rate/:job", (req, p) => {
  if (!D.shared(p.job)) throw new HttpError(404, "no such video");
  const r = D.ratingBy(p.job, voter(req, p.job).id);
  return json(r && { stars: r.stars, text: r.text });
});
route("POST", "/api/rate/:job", async (req, p, ip) => {
  if (!D.shared(p.job)) throw new HttpError(404, "no such video");
  rateLimit(ip, "rate", 60);
  const b = await body(req);
  const stars = Number(b.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad("stars must be 1 to 5");
  const v = voter(req, p.job);
  D.rate(p.job, v.id, v.owner, stars, str(b.text, "feedback", 1000, false));
  return Response.json({ ok: true }, { headers: v.setCookie ? { "set-cookie": v.setCookie } : {} });
});
route("GET", "/api/stories", () => json({
  stories: readdirSync(join(PUBLIC, "loops")).filter((f) => f.endsWith(".mp4") && f !== "transition.mp4").sort(),
}));

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
  const chats = D.chatsOf(u.id);
  return json({
    name: u.name, left: u.credits - u.used, idea: chats.length ? "" : u.idea,
    chats: chats.map((c) => ({ id: c.id, status: c.status, first: D.messages(c.id)[0]?.body ?? "" })),
  });
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

// the public version of a chat's finished video, for links into chats that aren't yours
route("GET", "/api/chats/:id/share", (_req, p) => {
  const j = D.versions(p.id).at(-1);
  if (!j) throw new HttpError(404, "no shared video");
  return json({ share: `/v/${j.id}` });
});

route("POST", "/api/chats/:id/messages", async (req, p) => {
  const { c } = myChat(req, p.id);
  if (!["awaiting", "thinking", "idle", "done"].includes(c.status)) throw bad("this video is already being made");
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
route("GET", "/api/worker/ratings/new", (req) => {
  worker(req);
  return json(D.unannouncedRatings().map((r) => ({ ...r, title: D.shared(r.job_id)?.title ?? "", maker: makerOf(r.job_id) })));
});
route("POST", "/api/worker/ratings/announced", async (req) => {
  worker(req);
  const b = await body(req);
  D.markRatingAnnounced(str(b.job, "job", 40), str(b.voter, "voter", 40), Number(b.at));
  return json({ ok: true });
});
const makerOf = (jobId: string) => { const j = D.job(jobId), c = j && D.chat(j.chat_id); return (c && D.userById(c.user_id)?.name) ?? "?"; };
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
  for (const x of b.parts) if (!["text", "media", "plan", "edit"].includes(x.kind)) throw bad(`unknown part kind ${x.kind}`);
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
  try { D.botReplies(p.id, parts(b), str(b.session, "session", 100, false)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, (e as Error).message); }
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
  const poster = new URL(req.url).searchParams.get("poster");
  D.finishJob(p.id, name, poster && /^[0-9a-f]+\.jpg$/.test(poster) ? poster : null);
  const c = D.chat(j.chat_id)!;
  await E.videoReady(D.userById(c.user_id)!, c.id, j.id);
  return json({ ok: true, video: `/media/${name}` });
});
route("POST", "/api/worker/jobs/:id/poster", async (req, p) => {
  worker(req);
  const poster = str((await body(req)).poster, "poster", 40);
  if (!/^[0-9a-f]+\.jpg$/.test(poster) || !D.job(p.id)) throw bad("poster must be a media .jpg name of an existing job");
  D.setPoster(p.id, poster);
  return json({ ok: true });
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
    const method = req.method === "HEAD" ? "GET" : req.method;
    try {
      for (const [m, re, h] of routes) {
        const hit = method === m && re.exec(u.pathname);
        if (hit) return await h(req, hit.groups ?? {}, ip);
      }
      if (method === "GET") {
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

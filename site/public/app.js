import { benbot } from "./bot.js";

const app = document.getElementById("app");
const SAMPLES = ["roadster-hop", "grok-hype", "ssd-brawl", "v2v-assemble"];
const IDEAS = [
  "me winning a soccer game against Messi",
  "the tesla roadster doing kickflips over things",
  "Costco snacks being delivered to the office",
  "my 16 agents building a client demo in 15 minutes",
  "airsoft strategy",
  "the entire office getting Arc'teryx vests",
  "slopbot foraging for AI slop in the jungle",
];
const POLL_MS = 2000;
const LIVE_POLL_MS = 400;
let stop = () => {};

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function mount(id) {
  stop(); stop = () => {};
  app.replaceChildren(document.getElementById(id).content.cloneNode(true));
  return app.firstElementChild;
}

function carousel(el) {
  let i = 0;
  const frame = Object.assign(document.createElement("div"), { className: "frame" });
  const v = Object.assign(document.createElement("video"), { muted: true, autoplay: true, loop: true, playsInline: true, controls: true });
  frame.append(v);
  const arrow = (cls, d, label) => {
    const b = Object.assign(document.createElement("button"), { className: `arrow ${cls}`, textContent: label, ariaLabel: cls });
    b.onclick = () => show(i + d);
    return b;
  };
  const show = (k) => { i = (k + SAMPLES.length) % SAMPLES.length; v.poster = `/samples/${SAMPLES[i]}.jpg`; v.src = `/samples/${SAMPLES[i]}.mp4`; };
  el.append(arrow("prev", -1, "‹"), frame, arrow("next", 1, "›"));
  show(0);
  return glowFrom(v);
}

/** The playing video's colors, blurred huge behind the page. */
function glowFrom(v) {
  let c = document.getElementById("glow");
  if (!c) { c = Object.assign(document.createElement("canvas"), { id: "glow", width: 32, height: 18 }); document.body.prepend(c); }
  const ctx = c.getContext("2d");
  let timer = setInterval(() => {
    if (v.readyState < 2) return;
    ctx.drawImage(v, 0, 0, 32, 18);
    c.classList.add("on");
  }, 120);
  return () => { clearInterval(timer); c.classList.remove("on"); };
}

/** Types the ideas into the empty input's placeholder, one after another. */
function autotype(input, ghost) {
  let idea = 0, n = 0, dir = 1, timer;
  const tick = () => {
    const s = IDEAS[idea];
    ghost.hidden = input.value !== "";
    ghost.textContent = s.slice(0, n);
    let wait = dir > 0 ? 45 + Math.random() * 50 : 18;
    n += dir;
    if (n > s.length) { dir = -1; wait = 1600; }
    if (n < 0) { dir = 1; n = 0; idea = (idea + 1) % IDEAS.length; wait = 350; }
    timer = setTimeout(tick, wait);
  };
  tick();
  return () => clearTimeout(timer);
}

// ---------------------------------------------------------------- screens
function gate() {
  const s = mount("t-gate");
  stop = carousel(s.querySelector(".carousel"));
  s.querySelector("[data-go=request]").onclick = request;
  s.querySelector("[data-go=login]").onclick = login;
}

function request() {
  const s = mount("t-request");
  const f = s.querySelector("form"), err = s.querySelector(".err");
  f.onsubmit = async (e) => {
    e.preventDefault();
    f.querySelector("button").disabled = true;
    try {
      const r = await api("/api/requests", { method: "POST", body: Object.fromEntries(new FormData(f)) });
      mount(r.already ? "t-already" : "t-requested");
    } catch (x) {
      err.textContent = x.message;
      f.querySelector("button").disabled = false;
    }
  };
}

function login() {
  const s = mount("t-login");
  const f = s.querySelector("form"), err = s.querySelector(".err");
  f.onsubmit = async (e) => {
    e.preventDefault();
    f.querySelector("button").disabled = true;
    try {
      await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(f)) });
      mount("t-sent");
    } catch (x) {
      err.textContent = x.message;
      f.querySelector("button").disabled = false;
    }
  };
}

function home() {
  const s = mount("t-home");
  const stopGlow = carousel(s.querySelector(".carousel"));
  const f = s.querySelector("form"), input = f.querySelector("input"), err = s.querySelector(".err");
  const ghost = f.querySelector(".ghost");
  const stopTyping = autotype(input, ghost);
  // BenBot peeks over the bar and watches the words go in
  let bot = null;
  benbot("peek").then((b) => { bot = b; f.prepend(b.el); });
  const watch = () => bot?.look(Math.min(1, (input.value || ghost.textContent).length / 40) * 1.6 - .6, .5, 600);
  const watching = setInterval(watch, 300);
  input.addEventListener("input", () => { watch(); if (input.value.length === 1) bot?.bounce(); });
  stop = () => { stopGlow(); stopTyping(); clearInterval(watching); bot?.stop(); };
  input.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    f.querySelector("button").disabled = true;
    bot?.hop();
    try {
      const chat = await api("/api/chats", { method: "POST", body: { text: `Make an epic video of ${text}` } });
      await transition();
      location.hash = `chat/${chat.id}`;
    } catch (x) {
      err.textContent = x.message;
      f.querySelector("button").disabled = false;
    }
  };
}

/** The idea-to-chat animation; resolves when it ends. */
function transition() {
  return new Promise((done) => {
    const t = document.getElementById("t-transition").content.firstElementChild.cloneNode(true);
    const v = t.querySelector("video");
    const end = () => { t.remove(); done(); };
    v.onended = end;
    v.onerror = () => { console.error("transition video failed to load:", v.src); end(); };
    document.body.append(t);
  });
}

function bubble(m, chat, onGenerate) {
  const el = document.createElement("div");
  el.className = `msg ${m.sender} ${m.kind}`;
  if (m.kind === "media") {
    const clips = Object.assign(document.createElement("div"), { className: "clips" });
    for (const x of m.media) {
      const c = document.createElement(x.type === "video" ? "video" : "img");
      c.src = x.url;
      if (x.type === "video") Object.assign(c, { controls: true, playsInline: true, preload: "metadata" });
      clips.append(c);
    }
    el.append(clips);
    if (m.body) el.append(Object.assign(document.createElement("div"), { textContent: m.body }));
  } else if (m.kind === "plan") {
    el.append(Object.assign(document.createElement("div"), { textContent: m.body }));
    const b = Object.assign(document.createElement("button"), { className: "btn go", textContent: "Generate Video" });
    b.dataset.plan = m.id;
    b.onclick = () => onGenerate(m.id, b);
    el.append(b);
  } else el.textContent = m.body;
  return el;
}

function chatScreen(id) {
  const s = mount("t-chat");
  const log = s.querySelector(".log"), f = s.querySelector("form"), input = f.querySelector("input");
  // while the planner works: the bubbles it's writing (the newest typed out smoothly as its words stream in) and what
  // it's doing
  const liveBox = Object.assign(document.createElement("div"), { className: "live" });
  const drafts = Object.assign(document.createElement("div"), { className: "drafts" });
  const working = Object.assign(document.createElement("div"), { className: "working", innerHTML: "<span class='pulse'></span><span class='what'></span>" });
  const what = working.querySelector(".what");
  liveBox.append(drafts, working);
  // BenBot sits at the bottom of the chat: thinks while it works, bounces when a bubble lands, hops on a plan
  let bot = null, first = true;
  benbot().then((b) => { bot = b; working.prepend(b.el); bot.think(status === "awaiting" || status === "thinking"); });
  let last = 0, alive = true, status = "";
  const landed = [];
  let target = "", shown = 0, raf = 0;
  stop = () => { alive = false; cancelAnimationFrame(raf); bot?.stop(); };

  const type = () => {
    raf = 0;
    const el = drafts.lastElementChild;
    if (!el) return;
    const behind = target.length - shown;
    if (behind > 0) shown += Math.max(1, Math.ceil(behind / 12));
    el.textContent = target.slice(0, shown);
    log.scrollTop = log.scrollHeight;
    if (shown < target.length) raf = requestAnimationFrame(type);
  };
  const setDrafts = (json) => {
    let list = [];
    try { list = json ? JSON.parse(json) : []; } catch (x) { console.error("bad draft", x); }
    // bubbles that have already landed aren't drafts any more
    list = list.filter((d) => d && !landed.some((b) => b.startsWith(d)));
    while (drafts.children.length > list.length) drafts.lastElementChild.remove();
    while (drafts.children.length < list.length) { drafts.append(Object.assign(document.createElement("div"), { className: "msg bot draft" })); shown = 0; }
    list.forEach((d, i) => { if (i < list.length - 1) drafts.children[i].textContent = d; });
    const newest = list.at(-1) ?? "";
    if (!newest.startsWith(target.slice(0, shown))) shown = 0;
    target = newest;
    if (newest && !raf) raf = requestAnimationFrame(type);
  };
  const setDoing = (text) => {
    if (what.textContent === text) return;
    if (what.textContent) bot?.look(Math.random() * 2 - 1, -.6, 1200);
    what.textContent = text;
    what.classList.remove("swap"); void what.offsetWidth; what.classList.add("swap");
  };

  const generate = async (planId, btn) => {
    btn.disabled = true;
    try {
      await api(`/api/chats/${id}/generate`, { method: "POST", body: { plan: planId } });
      route();
    } catch (x) {
      btn.disabled = false;
      btn.textContent = x.message;
    }
  };

  const render = (c) => {
    for (const m of c.messages) {
      const el = bubble(m, c, generate);
      if (!first) el.classList.add("land");
      log.insertBefore(el, liveBox.isConnected ? liveBox : null);
      last = m.id;
      if (m.sender === "bot") {
        landed.push(m.body);
        if (!first) m.kind === "plan" ? bot?.hop() : bot?.bounce();
      }
    }
    first = false;
    status = c.status;
    if (["queued", "cooking", "done"].includes(status)) return route();
    // only the newest plan can be generated
    const plans = log.querySelectorAll("[data-plan]");
    plans.forEach((b, k) => { b.hidden = k !== plans.length - 1 || status === "failed"; });
    const waiting = status === "awaiting" || status === "thinking";
    if (!liveBox.isConnected) log.append(liveBox);
    bot?.think(waiting);
    if (waiting) {
      setDrafts(c.live?.draft ?? "");
      setDoing(c.live?.steps?.at(-1)?.text ?? "Thinking");
    } else { setDrafts(""); what.textContent = ""; }
    if (status === "failed" && !log.querySelector(".failed")) {
      log.append(Object.assign(document.createElement("div"), { className: "msg bot failed", textContent: "That one blew up while cooking. Ben's been told, and you got your generation back. Start a new one from the home page." }));
      f.hidden = true;
    }
    if (c.messages.length || waiting) log.scrollTop = log.scrollHeight;
  };

  const poll = async () => {
    if (!alive) return;
    try { render(await api(`/api/chats/${id}?after=${last}`)); }
    catch (x) { if (x.status === 404) return home(); console.error(x); }
    if (alive) setTimeout(poll, status === "awaiting" || status === "thinking" ? LIVE_POLL_MS : POLL_MS);
  };

  f.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try { await api(`/api/chats/${id}/messages`, { method: "POST", body: { text } }); }
    catch (x) { input.value = text; console.error(x); return; }
    poll();
  };
  // stay pinned to the bottom while content grows (images, clips, BenBot arriving), unless they've scrolled up
  let stuck = true;
  log.addEventListener("scroll", () => { stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 80; });
  const pin = () => { if (stuck) log.scrollTop = log.scrollHeight; };
  new ResizeObserver(pin).observe(log);
  new MutationObserver(pin).observe(log, { childList: true, subtree: true, characterData: true });
  log.addEventListener("load", pin, true);
  log.addEventListener("loadedmetadata", pin, true);
  input.addEventListener("input", () => bot?.look(-.2, 1, 900));
  input.focus();
  poll();
}

function cooking(id) {
  const s = mount("t-cooking");
  const eta = s.querySelector(".eta"), fill = s.querySelector(".fill");
  let alive = true;
  stop = () => { alive = false; };
  const poll = async () => {
    if (!alive) return;
    const c = await api(`/api/chats/${id}`);
    if (c.status === "done") return done(c);
    if (c.status === "failed") return chatScreen(id);
    const j = c.job;
    const mins = j.eta_at ? Math.max(1, Math.round((j.eta_at - Date.now()) / 60000)) : null;
    eta.textContent = c.status === "queued" ? "In line. The hype is queueing." : mins ? `T-${mins} minute${mins === 1 ? "" : "s"} till it's ready` : "Warming up the hype";
    fill.style.width = `${Math.max(2, Math.round(j.pct * 100))}%`;
    setTimeout(poll, POLL_MS * 2);
  };
  poll().catch(console.error);
}

function done(c) {
  const s = mount("t-done");
  s.querySelector("video").src = c.job.video;
}

// ---------------------------------------------------------------- routing
async function route() {
  let meData;
  try { meData = await api("/api/me"); }
  catch (x) { if (x.status === 401) return gate(); throw x; }
  const m = /^#chat\/(\w+)$/.exec(location.hash);
  if (!m) return home();
  const c = await api(`/api/chats/${m[1]}`).catch((x) => { if (x.status === 404) return null; throw x; });
  if (!c) { location.hash = ""; return home(); }
  if (c.status === "done") return done(c);
  if (c.status === "queued" || c.status === "cooking") return cooking(c.id);
  chatScreen(c.id);
}

addEventListener("hashchange", route);
route();

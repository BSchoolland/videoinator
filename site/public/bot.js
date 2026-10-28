// BenBot, the teal Grok Bot, alive on the page: idle bob, blinks, eye-darts, and reactions the chat triggers.
let svgText;
const loadSvg = () => (svgText ??= fetch("/benbot.svg").then((r) => r.text()));

export async function benbot(cls = "") {
  const el = Object.assign(document.createElement("span"), { className: `bb ${cls}` });
  el.innerHTML = await loadSvg();
  const eyes = el.querySelector(".eyes");
  let alive = true, held = false;
  const later = (ms, f) => setTimeout(() => alive && f(), ms);

  const blink = () => { el.classList.add("blink"); later(110, () => el.classList.remove("blink")); later(1800 + Math.random() * 3500, blink); };
  /** dx, dy in -1..1: where to look */
  const look = (dx, dy) => { eyes.style.translate = `${dx * 22}px ${dy * 16}px`; };
  const dart = () => { if (!held) look(Math.random() * 2 - 1, Math.random() * 1.4 - .7); later(1200 + Math.random() * 2600, dart); };
  const once = (c) => { el.classList.remove(c); void el.offsetWidth; el.classList.add(c); later(800, () => el.classList.remove(c)); };
  later(900, blink);
  later(1500, dart);

  return {
    el,
    look(dx, dy, ms = 1500) { held = true; look(dx, dy); later(ms, () => { held = false; }); },
    bounce: () => once("bounce"),
    hop: () => once("hop"),
    think: (on) => el.classList.toggle("think", on),
    stop() { alive = false; },
  };
}

// Five stars and an optional "what would've made it better?" under a finished video.
// <div class="rate" data-job="<job id>"></div>, then mountRating(el).
export async function mountRating(el) {
  const job = el.dataset.job;
  el.innerHTML = `<p class="rate-q">How hype was it?</p>
<div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="star" data-n="${n}" role="radio" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
<form class="rate-more" hidden><textarea maxlength="1000" rows="3" placeholder="What would've made it better? (optional)"></textarea>
<button class="btn">Send</button></form><p class="rate-done" hidden>Thanks! BenBot is taking notes.</p>`;
  const stars = [...el.querySelectorAll(".star")], form = el.querySelector("form"), box = el.querySelector("textarea");
  const done = el.querySelector(".rate-done");
  let picked = 0;
  const show = (n) => stars.forEach((s, i) => { s.classList.toggle("on", i < n); s.setAttribute("aria-checked", String(i + 1 === n)); });
  const save = async () => {
    const r = await fetch(`/api/rate/${job}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stars: picked, text: box.value }) });
    if (!r.ok) throw new Error(`rating failed: ${r.status} ${await r.text()}`);
  };
  stars.forEach((s) => {
    s.onmouseenter = () => show(+s.dataset.n);
    s.onclick = async () => { picked = +s.dataset.n; show(picked); form.hidden = false; done.hidden = true; await save(); };
  });
  el.querySelector(".stars").onmouseleave = () => show(picked);
  form.onsubmit = async (e) => { e.preventDefault(); await save(); form.hidden = true; done.hidden = false; };

  const r = await fetch(`/api/rate/${job}`);
  if (!r.ok) throw new Error(`could not load the rating: ${r.status}`);
  const mine = await r.json();
  if (mine) { picked = mine.stars; box.value = mine.text; show(picked); done.hidden = false; }
}

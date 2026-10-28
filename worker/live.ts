// The planner's stream-json, turned into what the user sees while it works: plain-English steps ("Searching …",
// "Cutting a clip from youtube.com") and the words of the bubble it's writing, as the model writes them.

export interface Step { text: string; at: number }

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "the web"; } };
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What a finished tool call looks like to the user; null for calls that are themselves bubbles. */
export function stepText(name: string, input: any): string | null {
  if (name === "WebSearch") return `Searching "${short(String(input.query ?? ""))}"`;
  if (name === "WebFetch") return `Reading ${host(String(input.url ?? ""))}`;
  if (name === "Read") return /-sheet\.jpg$/.test(String(input.file_path)) ? "Watching the clip" : "Looking at an image";
  if (name !== "Bash") return "Thinking";
  const cmd = String(input.command ?? "").trim();
  const words = cmd.split(/\s+/);
  switch (words[0]) {
    case "./say": case "./plan": return null;
    case "./clip": return `Cutting a clip from ${host(words[1]?.replace(/^["']|["']$/g, "") ?? "")}`;
    case "./grab": return `Grabbing an image from ${host(words[1]?.replace(/^["']|["']$/g, "") ?? "")}`;
    case "./show": return "Putting it in the chat";
    default: return "Working";
  }
}

/** The text of every ./say or ./plan bubble so far in a partial Bash tool-input JSON (a command can chain several). */
export function draftsOf(partialJson: string): string[] {
  // JSON-unescape what has arrived; a dangling backslash is the start of an escape still on its way
  const raw = partialJson.replace(/\\$/, "");
  let cmd = "";
  const start = raw.search(/"command"\s*:\s*"/);
  if (start < 0) return [];
  const body = raw.slice(raw.indexOf('"', raw.indexOf(":", start)) + 1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '"') break;
    if (body[i] !== "\\") { cmd += body[i]; continue; }
    const c = body[++i];
    cmd += c === "n" ? "\n" : c === "t" ? "\t" : c === "u" ? String.fromCharCode(parseInt(body.slice(i + 1, (i += 4) + 1), 16) || 32) : c ?? "";
  }
  const out: string[] = [];
  const re = /\.\/(?:say|plan)\s+(["'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    let s = "", i = m.index + m[0].length;
    // the shell string runs to its closing quote; inside "…" a quote the shell sees is escaped as \"
    for (; i < cmd.length; i++) {
      if (cmd[i] === m[1]) break;
      if (m[1] === '"' && cmd[i] === "\\" && i + 1 < cmd.length) { s += cmd[++i]; continue; }
      s += cmd[i];
    }
    out.push(s);
    re.lastIndex = i + 1;
  }
  return out;
}

/** Feed it stream-json lines; it calls onChange when the steps or the draft change. */
export class LiveView {
  steps: Step[] = [];
  /** The bubbles being written in the current model message, in order (several tool calls or a chained command). */
  private drafts = new Map<number, string[]>();
  private blocks = new Map<number, { name: string; json: string }>();
  private onChange: (v: { steps?: Step[]; draft?: string }) => void;
  constructor(onChange: (v: { steps?: Step[]; draft?: string }) => void) { this.onChange = onChange; }

  private step(text: string) {
    if (this.steps.at(-1)?.text === text) return;
    this.steps = [...this.steps, { text, at: Date.now() }];
    this.onChange({ steps: this.steps });
  }

  line(e: any) {
    if (e.type !== "stream_event") return;
    const ev = e.event;
    if (ev.type === "message_start") this.drafts.clear();
    else if (ev.type === "content_block_start") {
      const b = ev.content_block;
      if (b.type === "tool_use") this.blocks.set(ev.index, { name: b.name, json: "" });
      else if (b.type === "thinking") this.step("Thinking");
    } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
      const b = this.blocks.get(ev.index);
      if (!b) return;
      b.json += ev.delta.partial_json;
      if (b.name === "Bash") {
        const d = draftsOf(b.json);
        if (d.length && JSON.stringify(d) !== JSON.stringify(this.drafts.get(ev.index))) {
          this.drafts.set(ev.index, d);
          this.onChange({ draft: JSON.stringify([...this.drafts.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, v]) => v)) });
        }
      }
    } else if (ev.type === "content_block_stop") {
      const b = this.blocks.get(ev.index);
      if (!b) return;
      this.blocks.delete(ev.index);
      let input: any = {};
      try { input = JSON.parse(b.json || "{}"); } catch { /* a malformed call fails in the tool itself, loudly */ }
      const t = stepText(b.name, input);
      if (t) this.step(t);
    }
  }
}

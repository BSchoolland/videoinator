# Epic Video-inator

The code behind [benbot.si](https://benbot.si): tell BenBot an idea, plan it with him in a chat, hit Generate, and an
hour later a team of AI agents hands you a 90-second music video, built frame by frame in code with its own original
song.

## How a video gets made

1. **Planner.** A Claude Code session with attitude chats with you, looks up references, and pitches a plan with a
   Generate button (`worker/planner.ts`, `worker/prompts/PLANNER.md`). Replies stream in as it writes them.
2. **Director 1.** Makes an original Suno track first, then builds the whole video in Python with
   `reel/`: generated art, vector-rigged characters, effects, every cut snapped to a
   hit in the music (`worker/prompts/DIRECTOR.md`, `MUSIC.md`).
3. **Critic + cold viewer.** A blind critic reviews the cut against the brief, and a cold viewer who sees only frames
   at 4 fps (and a written account of the soundtrack) says what they think it's about, where they got lost or bored,
   and what they'd change (`worker/prompts/COLDVIEW.md`, `reel/CRITIC.md`).
4. **Director 2.** Fixes what they found. The finished cut gets a share page with a playable link preview.

## Layout

- `site/`: the website and its API. Bun + `bun:sqlite`, no framework. Invite-only access with emailed sign-in links
  (no passwords), the planner chat, the cooking page, share pages (`/v/<id>`) with Discord/Slack/iMessage video cards,
  and star ratings.
- `reel/`: the Python library the directors build videos with: drawing, character acting, effects, beat analysis,
  synthesized SFX, image generation, parallel rendering, and the critic's measurements. `reel/GUIDE.md` is what a
  director reads first. Setup: `cd reel && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -e . pytest`.
- `worker/`: runs on a separate machine with the agents. It polls the site for access requests, planner turns and
  video jobs, runs them as `claude -p` sessions, and reports back.

## Running it

Site: `cd site && WORKER_TOKEN=… BASE_URL=https://your.site bun src/server.ts` (`DEV=1` for local development; mail goes
out through `sendmail`). Worker: `cd worker && SITE=https://your.site WORKER_TOKEN=… BEN_CHANNEL=… node worker.ts`
(Node 24). The worker expects the Claude Code CLI, `codex` (image generation), ffmpeg,
and a logged-in Chrome for Suno. The worker looks for reel's venv at `reel/.venv`; the director prompts point at
`~/Projects/reel`, so link it there or edit the paths. It was built for one person's setup, so expect to adapt the paths.

## License

MIT

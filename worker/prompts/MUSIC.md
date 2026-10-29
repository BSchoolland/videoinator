## The music comes first

assets/song.mp3 doesn't exist yet: you make it, an original Suno track, before anything else, since every cut lands
on it. Suno runs in Ben's logged-in Chrome, which other videos share, so:

1. `{TOOLS}/suno-lock take` (it waits if another video is in Suno). Everything in Suno happens between take and drop.
2. Read ~/Projects/benbot/skills/browse-as-ben/SKILL.md: you drive the browser with
   `node ~/Projects/benbot/services/budget/driver.mjs`, run from ~/Projects/benbot/workspaces/1207975516687171654.
3. On suno.com/create, write a style prompt for the plan's music vibe, starting with "Epic, hype" (built for this video's story and its payoff;
   instrumental unless the plan clearly wants lyrics, and then short, funny, clean ones you write). Describing the
   shape you'd like (a breakdown, then a drop) is fine, but Suno won't follow it closely. Set the length to 1:30 under
   Advanced. Create it; Suno makes two takes.
4. When both are done, record them: `{TOOLS}/suno-record assets/music a:<clip id> b:<clip id>` (the id is the uuid in
   suno.com/song/<id>). It plays each in Chrome and records it, in real time.
5. `{TOOLS}/suno-lock drop`.
6. Pick the take that sounds the most awesome, not the one closest to your plan, and don't make more takes chasing a
   shape. `python {TOOLS}/audio-summary.py assets/music/<x>.mp3` describes each one for you. Copy the pick to
   assets/song.mp3, run `python -m reel.music` (work/audio.json: onsets and the beat grid), and plan the video around
   the song as it really is: its own builds, hits and quiet stretches are where the story's moments land. Note the clip
   ids, the style prompt and your pick in STATE.md.

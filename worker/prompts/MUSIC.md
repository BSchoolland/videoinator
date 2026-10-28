## The music comes first

assets/song.mp3 doesn't exist yet: you make it, an original Suno track, before anything else, since every cut lands
on it. Suno runs in Ben's logged-in Chrome, which other videos share, so:

1. `{TOOLS}/suno-lock take` (it waits if another video is in Suno). Everything in Suno happens between take and drop.
2. Read ~/Projects/benbot/skills/browse-as-ben/SKILL.md: you drive the browser with
   `node ~/Projects/benbot/services/budget/driver.mjs`, run from ~/Projects/benbot/workspaces/1207975516687171654.
   Work in your own new tab, and touch nothing else in his browser.
3. On suno.com/create, write a style prompt for the plan's music vibe (built for this video's story and its payoff;
   instrumental unless the plan clearly wants lyrics, and then short, funny, clean ones you write). Ask for the shape
   the story needs, above all a real drop (a breakdown, then everything back in) where the plan's climax lands; a
   track that stays equally loud from start to end gives the payoff nothing to hit. Set the length to 1:30 under
   Advanced. Create it; Suno makes two takes.
4. When both are done, record them: `{TOOLS}/suno-record assets/music a:<clip id> b:<clip id>` (the id is the uuid in
   suno.com/song/<id>). It plays each in Chrome and records it, in real time.
5. `{TOOLS}/suno-lock drop`.
6. Pick the take that fits the story better, copy it to assets/song.mp3, and run `python -m reel.music`
   (work/audio.json: onsets and the beat grid). Note the clip ids, the style prompt and your pick in STATE.md.

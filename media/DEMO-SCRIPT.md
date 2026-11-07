# dsh-board demo — script & storyboard

Two cuts are maintained:

- **v2 (current): 41.2 s, 1920×1080, 30 fps, with ambient music, animated title/outro cards, cross-fades and animated captions.**
- v1 (legacy): 38.4 s, 1280×720, silent, static title cards.

Re-render v2:

```sh
node scripts/demo-cards.mjs      # animated 1080p title/outro (needs cached Chromium)
node scripts/demo-video.mjs      # scripted UI recording (raw)
bash scripts/build-demo-v2.sh    # music bed, transitions, captions, mux
```

## v2 timeline

| Time | Scene | Caption |
|---|---|---|
| 0:00–0:06 | Animated title card | — |
| 0:06–0:11 | Seeded board | Every ticket becomes an isolated agent run |
| 0:11–0:13 | Search | Search, filter, jump across the whole board |
| 0:13–0:16 | Plan-review drawer | Plan with the agent before any code runs |
| 0:16–0:22 | Review panel | Review the diff, checks and transcript |
| 0:22–0:25 | Review → reject/approve | Reject resumes the session · approve merges |
| 0:25–0:29 | Batch selection | Batch select, filter and route the queue |
| 0:29–0:32 | Insights | Insights, inbox and deep links, built in |
| 0:32–0:35 | Return to board | Humans keep the gates |
| 0:35–0:41 | Animated outro | — |

Music is a locally synthesized ambient bed (`media/anim/music.wav`, ffmpeg `aevalsrc`), designed to be
swapped for a licensed track. The interactive version of the tour lives at
`docs/demo.html` (GitHub Pages).

## Suggested narration

> This is dsh-board, a ticket-first board for DeepSeek Harness. Create a ticket and it becomes a
> real, isolated run instead of a chat message. The agent explores and proposes a plan; you approve it
> before any code is written. Every run gets its own Git worktree. Review the diff, the checks and the
> worker's transcript. Reject resumes the same worker with your notes; approve squash-merges the branch.
> Operate the whole queue in batches. Insights, a durable inbox and shareable ticket links are built in.
> Agents do the work. Humans keep the gates.

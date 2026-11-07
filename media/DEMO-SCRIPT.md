# dsh-board demo — script & storyboard

Runtime: **38.4 s**, 1280×720, 25 fps, silent with burned-in captions.
Re-render: `node scripts/demo-video.mjs && bash scripts/build-demo-video.sh`
(needs `DSH_BIN` or `dsh` on PATH and a cached Chromium).

| Time | Scene | On-screen caption | Suggested voice-over |
|---|---|---|---|
| 0:00–0:04 | Title card | — | "This is dsh-board — a ticket-first board for DeepSeek Harness." |
| 0:04–0:09 | Seeded board | Every ticket becomes an isolated agent run | "Create a ticket, and it becomes a real, isolated run instead of a chat message." |
| 0:09–0:11 | Search / filters | Search, filter and jump across the whole board | "Find anything instantly — by text, state, assignee or saved view." |
| 0:11–0:14 | Plan review drawer | Plan with the agent before any code runs | "The agent explores and proposes a plan; you approve it before any code is written." |
| 0:14–0:18.5 | Review panel | Review the diff, checks and worker transcript | "Every run gets its own Git worktree. Review the diff, the checks and the worker's transcript." |
| 0:18.5–0:23 | Review → reject/approve | Reject resumes the session · approve merges | "Reject resumes the same worker with your notes. Approve squash-merges the branch." |
| 0:23–0:26 | Batch selection | Batch select, filter and route the queue | "Operate the whole queue: select, assign, archive, all in one action." |
| 0:26–0:30 | Insights drawer | Insights, inbox and deep links, built in | "Insights, a durable inbox and shareable ticket links are built in." |
| 0:30–0:33 | Board again | Humans keep the gates — agents do the work | "Agents do the work. Humans keep the gates." |
| 0:33–0:38 | Outro card | — | "MIT licensed. Clone it, run the install script, and open the board." |

## Suggested narration (full read)

> This is dsh-board, a ticket-first board for DeepSeek Harness. Create a ticket and it becomes a
> real, isolated run instead of a chat message. Find anything instantly — by text, state, assignee or
> saved view. The agent explores and proposes a plan; you approve it before any code is written.
> Every run gets its own Git worktree. Review the diff, the checks and the worker's transcript.
> Reject resumes the same worker with your notes; approve squash-merges the branch. Operate the whole
> queue: select, assign, archive, all in one action. Insights, a durable inbox and shareable ticket
> links are built in. Agents do the work. Humans keep the gates. MIT licensed — clone it, run the
> install script, and open the board.

No voice track is included; the MP4 is silent with captions so it autoplays anywhere. Record the
narration above and mux it with `ffmpeg -i dsh-board-demo.mp4 -i voice.wav -shortest ...` if wanted.

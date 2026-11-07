# dsh-board — improvement roadmap

Written against the v1 MVP (16 tickets / 21 runs of real data, all six slices verified in
`README.md` §Verification history). Every claim below is anchored to code or to a platform API in
the installed Harness checkout, and the correctness items in Slice 0 were reproduced against
`lib/store.js` / `lib/runs.js` with a faked `ctx` (no models, no network).

**Thesis.** The board's product is the *gate*: a human approves a branch into a repo. Everything
else — columns, cards, runs — is plumbing for that moment. So the order of investment is:

1. **Trust floor** — the board must never lose data and must never merge into the wrong branch.
2. **A real gate** — the reviewer must see the change and the evidence at the moment of approval.
3. **A steerable loop** — comments reach the worker, notifications reach the human, no 3 s polling.
4. **A scheduler** — dependencies, priority, budgets, retention. This is where a board beats chat.

## Status

- **Slice 0 — landed** (2026-11-05). All twelve items implemented; `npm test` runs 49/49 offline
  tests (store, run controller against fake agents + real temp Git repos, host routes and tools).
  Two deliberate deviations: there is no process-level lock file (the store refuses a stale write
  with an explicit error instead of preventing a second boot), and the scale work (snapshot
  summaries, activity caps) stays in Slice 3.4 rather than being smuggled into a bug fix.
  Verified against the original adversarial repros: the corrupt-board wipe, second writer,
  wrong-branch merge, cross-ticket index race, cancel-during-create and half-applied update all
  now fail closed.
- **Post-review fixes.** An independent adversarial review of the landed diff found three further
  blockers, now fixed and regression-tested: (1) Cancel could bypass the gate — cancel is refused
  at the gate and the button is hidden; (2) a ticket the worker moved to `blocked` could never be
  retried because its run was never closed — `settle` now closes it; (3) a merge whose record
  write failed stranded the ticket — approval now adopts the existing squash commit by subject on
  retry. Also fixed: rename-tolerant staged-path verification, tracked-file preservation proven by
  a hook that edits a tracked file, inode/ctime in the staleness guard, `.bak` frozen during
  recovery, snapshot/restore for approve/reject/cancel, agent ownership checks on `board_update`,
  claim status restrictions, Git command timeouts, and a plugin boot that cannot be broken by a
  recovery or migration failure. A second review pass then caught two defects in those fixes — a
  backup frozen for the process lifetime (a later corruption restored stale data) and a `chmod`
  triggering a false "changed on disk" wedge — both fixed, with a content-hash fallback in the
  writer guard and a gate ticket with no open work allowed back out.
- **Slice 1 — landed** (2026-11-05). Diff in the drawer (`GET /api/board/diff`), per-ticket checks run
  before the gate and enforced at approve (with a recorded human override), a review-first drawer
  (acceptance, checks, change, artifacts, run history), approve confirmation naming branch and base,
  and the gate idle guarantee (approval is also refused while checks are still running). `npm test` 66/66.
  Post-review fixes: checks are enforced for runs without a worktree too; signal-killed, aborted and
  failed-to-start checks are failures (not passes); an override is recorded only after the merge
  succeeds and now requires a reason; editing the check list invalidates old results and forces a
  re-run; uncommitted tracked changes in the run checkout refuse approval; stored boards over the
  check cap clamp on load instead of failing to boot; override/reject drafts no longer leak between
  tickets. A third pass made the diff cap byte-accurate (raw buffer, multi-byte safe) and turned the
  checkout guard from a point-in-time sample into a re-stat at approval: a newer HEAD or a dirty/clean
  transition re-runs the checks, so approval never merges code the checks did not see.
- **Slice 2 — landed** (2026-11-05). Steering comments into the live worker session, SSE push over
  `/board/events` replacing the 3 s poll (with a 15 s fallback), a sidebar attention badge, drawer
  authoring for title/description/acceptance, an agent-preset picker, and dialog/keyboard/contrast
  hygiene. `npm test` 80/80.
  Post-review fixes: acceptance criteria now participate in the store rollback and are capped on
  create/load; "Save details" sends only changed fields (a push update can no longer be reverted by
  a stale draft); comments are persisted with their delivery marker in one write and the action
  response reports whether the worker received them (the comment is persisted before delivery, so a failed write never double-sends; the delivery marker is best-effort); SSE listeners are capped and the channel is
  mounted through an optional injected `webServer`; the client gates refetches by revision,
  dedupes badge states (custom workflows) and retries presets; New-ticket dialogs got modal
  semantics.
- **Slice 4a — scale & operations** (2026-11-05). Compact summary state + per-ticket detail route,
  schema v2 migration, rotating numbered backups, completion metrics with 7-day throughput,
  hourly retention (archive + merged prune), and a real-profile e2e smoke script. `npm test`
  106/106, `npm run e2e` 10/10. Still deferred: a database backend (the write path rewrites one
  JSON document per mutation at any board size).
- **Slice 5C — subagent observability + subtree budget** (2026-11-05). `session/created`/`disposed`
  lineage tracking (including nested subagents), run-level `subagents` record, subtree token
  accounting in the watch and at settle, and a `maxSubagents` fan-out cap that blocks the run.
  `npm test` 111/111, `npm run e2e` 10/10.
- **Slice 20A — browser UI suite** (2026-11-07). `npm run ui` drives a real Chromium over the
  interactive paths (search, keyboard, saved views, batch, export, deep link, transcript picker, GC,
  PR action). 10/10 checks. `npm test` 146/146, `npm run e2e` 10/10.
- **Slice 19D — card component test** (2026-11-07). `TicketCard` rendered with the fake-React harness:
  chips/classes/click modes. Interactive components still need a DOM harness (not offline-installable).
  `npm test` 146/146, `npm run e2e` 10/10.
- **Slice 19C — journal writer guard** (2026-11-07). Journal size tracking refuses a second writer with
  a clear conflict instead of interleaving deltas. `npm test` 145/145, `npm run e2e` 10/10.
- **Slice 19A — client unit tests** (2026-11-07). Bundle-level `__test` hooks and a fake
  loader/React harness covering the pure client helpers.
- **Slice 19B — journal backend** (2026-11-07). Append-only delta journal with replay, corruption
  tolerance and atomic compaction for the JSON backend. `npm test` 144/144, `npm run e2e` 10/10.
- **UI verification pass** (2026-11-07). Live-verified the GC button (orphan branch removed, notice
  reported), the PR action's presence on a configured gate ticket, and confirmed previous live
  verifications (batch, export, transcript picker, saved views). Remaining: client component unit
  tests (needs a DOM harness) and the JSON append-only journal.
- **Slice 18C — team completion + live transcript** (2026-11-07). Bidirectional Agent Teams sync
  (board-done completes the team task; team-complete raises an advisory) and a 3 s transcript
  auto-refresh toggle. `npm test` 139/139, `npm run e2e` 10/10.
- **Slice 18B — PR auto-sync + transcript fallback** (2026-11-07). Provider-aware polling that
  completes tickets when a PR/MR merges and notifies when one closes unmerged; zstd CLI fallback for
  compressed session logs. `npm test` 138/138, `npm run e2e` 10/10.
- **Slice 18A — remaining integrations** (2026-11-07). GitLab merge-request provider, post-merge
  worktree/branch pruning, `board_team_sync` owner→assignee mirroring, and a transcript session
  picker in the drawer. Live-verified picker; `npm test` 137/137, `npm run e2e` 10/10.
- **Slice 17C — reviewer budget + auto-merge proof** (2026-11-07). Reviewer session token budgeting
  with cancellation/notification, and an integration test for the auto-merge success path.
  `npm test` 136/136, `npm run e2e` 10/10.
- **Slice 17B — safety hardening** (2026-11-07). Approval TTL, checks allow/deny policy enforced
  before execution, `run_failed` notifications, webhook retries + delivery log, SQLite integrity check
  and `.bak` rotation. Reviewer-session budgeting and the auto-merge success-path integration test
  remain for 17C. `npm test` 134/134, `npm run e2e` 10/10.
- **Slice 17A — Agent Teams + transcript** (2026-11-07). `board_team_task` publishes a ticket to
  the shared Team task board (task id/revision stored on the ticket), and the drawer embeds the
  worker's persisted session transcript via a board-scoped route. `npm test` 132/132,
  `npm run e2e` 10/10.
- **Slice 16A — database hardening** (2026-11-07). Revision-guarded multi-writer safety, on-demand
  `board.json` export, and query-friendly indexed ticket columns with in-place schema migration.
  `npm test` 130/130, `npm run e2e` 10/10.
- **Slice 15A — SQLite backend** (2026-11-07). Optional `backend: 'sqlite'` storage with WAL,
  row-level ticket/notification persistence, JSON import on first boot, and JSON fallback when
  `node:sqlite` is unavailable. `npm test` 129/129, `npm run e2e` 10/10.
- **Slice 14A — pull requests** (2026-11-07). Optional GitHub PR mode: push the reviewed branch,
  create a PR via the API, record it on the run/artifact, and complete the ticket with Mark PR merged.
  Local squash-merge remains the default. `npm test` 128/128, `npm run e2e` 10/10.
- **Slice 13A — export** (2026-11-06). CSV/JSON download of the currently filtered ticket set,
  built client-side. Live-verified; client-only.
- **Slice 12A — saved views** (2026-11-06). Named filter views in the toolbar (save/apply/delete,
  persisted in local storage). Live-verified; client-only.
- **Slice 11A — insights** (2026-11-06). Header Insights panel and `board.insights` snapshot field:
  throughput, cycle time (avg/p50), tokens per merge, reviews per ticket, run failure and check pass
  rates. `npm test` 127/127, `npm run e2e` 10/10.
- **Slice 10A — links & sessions** (2026-11-06). Hash deep links (`#B-3`) reveal the board and open
  the drawer, URL sync on open/close, a Copy link button, and reviewer/needs-input session links.
  Live-verified; client-only, so the 126-test suite and e2e are unchanged.
- **Slice 9F — worktree/branch GC** (2026-11-06). `/board gc` dry-run/apply action plus a header
  button: removes only unreferenced `board/*` worktrees/branches, prunes worktree metadata, reports
  per-target errors, and never touches referenced work or the workspace checkout. `npm test`
  126/126, `npm run e2e` 10/10.
- **Slice 9D — outbound webhooks** (2026-11-06). `webhooks` config delivers new notifications as
  Slack-compatible JSON with optional HMAC signatures, event filters, and a startup replay guard.
  `npm test` 125/125, `npm run e2e` 10/10.
- **Slice 9B — batch actions** (2026-11-06). Multi-select mode with batch approve/archive/assign
  through a `batch` route action (50-ticket cap, per-ticket results and failure reporting).
  Live-verified; `npm test` 124/124, `npm run e2e` 10/10.
- **Slice 9A/9C — find & flow + default assignee** (2026-11-06). Filter toolbar with full-text
  search, status/assignee filters, plan-review/needs-input toggles, persisted preferences, and
  `/`-focus plus `j/k/Enter/Esc` keyboard navigation; `autonomy.defaultAssignee` auto-assigns an
  approved plan and its children so dispatch needs no second drawer visit. Live-verified; `npm test`
  123/123, `npm run e2e` 10/10.
- **Slice 8A — reviewer auto-reject** (2026-11-06). `autonomy.autoRejectOnChanges` (default off)
  rejects a ticket on a `changes_requested` verdict using the reviewer notes, resuming the same
  worker session; without the policy the verdict stays advisory. `npm test` 122/122,
  `npm run e2e` 10/10.
- **Slice 6D — markdown + ticket links** (2026-11-06). Safe inline markdown for plan bodies,
  descriptions and activity/comment text (headings, bold, inline code, fenced blocks, bullets) and
  clickable `B-3` ticket references that open the referenced drawer. Live-verified.
- **Slice 7D — inbox UI** (2026-11-06). Header bell with unread count, notification drawer (ticket,
  kind, text, age), per-row read-on-open, and a Mark all read action backed by the
  `notifications-read` route. Live-verified on an isolated profile. Webhooks/desktop notifications
  remain deferred.
- **Slice 7C — reviewer automation + inbox** (2026-11-06). `autonomy.reviewerPreset` auto-opens an
  independent reviewer session when a run parks at the gate; durable notifications for needs-input,
  plan review, review-ready and reviewer verdicts with `/board notifications` to list/clear them and
  an unread count in the snapshot; new runs clear stale verdicts. Client inbox UI and notification
  webhooks deferred. `npm test` 121/121, `npm run e2e` 10/10.
- **Slice 7B — reviewer + trusted checks + opt-in auto-merge** (2026-11-06). Reviewer agents post
  verdicts with `board_review` (or `/board review`), checks carry provenance (`human` / `plan` /
  `agent`), and `autonomy.autoMerge` (default off) attempts the normal approval path only when the
  verdict is approved and every check is trusted. Notification inbox deferred. `npm test` 119/119,
  `npm run e2e` 10/10.
- **Slice 7A — autonomy policy** (2026-11-06). Opt-in `autonomy.agentsCanReady` / `.agentsCanAssign`
  let agents triage initial tickets to Ready and assign them (audited), with `autonomy.wipLimit`
  gating triage while work is in progress; the policy is exposed in the state snapshot. Auto-merge
  stays pinned off pending 7B (trusted checks + independent reviewer). `npm test` 117/117,
  `npm run e2e` 10/10.
- **Slice 6C — chat control** (2026-11-06). Host `/board` subcommands (`list`, `show`, `approve`,
  `answer`) and a client decoration that opens the Board panel on a bare invocation; the sidebar
  attention count now includes plan-review and needs-input tickets. Markdown rendering and ticket
  autolinks were deferred to 6D.
- **Slice 6B — sidebar live badge** (2026-11-06). The Board sidebar icon counts works in progress
  (blue) and falls back to the attention count (amber) when idle; tooltip/aria label name the count.
  Verified live on an isolated profile.
- **Slice 6A — `/board` intake** (2026-11-06). A host slash command creates a ticket from the chat,
  binds the invoking session as its planning session, and wakes the agent to brainstorm like plan
  mode; plan submission from that chat is authorized, plan acceptance/checks are copied onto the
  ticket at approval, and the manual New-ticket form is removed in favour of the command + empty-state
  hint. `npm test` 114/114, `npm run e2e` 10/10.
- **Slice 5D — human handoff** (2026-11-05). `board_ask` pauses a run into a `needs_input` state;
  answering resumes the same worker session with the reply (queued when no slot is free). Worker
  brief points at the tool. `npm test` 112/112, `npm run e2e` 10/10.
- **Slice 5A — planning gate** (2026-11-05). Ticket-bound planning sessions, `board_submit_plan`,
  plan review with approve/request-changes, plan-driven decomposition into child tickets, and
  parent auto-completion. Human merge gate unchanged. `npm test` 109/109, `npm run e2e` 10/10.
  Next: 5C subagent observability + per-run subtree budget; planning-session plan-mode UX polish.
- **Slice 3 — landed** (2026-11-05). Dependencies with cycle checks and auto-dispatch, a durable
  priority queue that survives restarts, wall-clock budgets alongside tokens, archive + prune of
  merged/archived checkouts, worker sessions attached to the board workspace (best effort), and a
  health strip (cycle time, tokens per merge). `npm test` 102/102. Still deferred from this slice: the
  snapshot summary/detail split for very large boards (state remains one full document).

  Post-review fixes: archiving refuses a live run and unmerged work without force; prune is
  opt-in for archived tickets, skips active runs, locks the repository, reports honestly and flags
  pruned runs so the gate/diff explain the loss instead of wedging the ticket. Reject no longer
  bypasses `maxWorkers`; the store rollback covers activity/artifacts arrays and all Slice 3 fields;
  the wall-clock deadline is measured from dispatch and re-read from the ticket (so lowering the
  budget mid-run stops the run); dependencies gate claims and fail closed on dangling ids; leaving
  Ready clears the queue marker and unarchiving dispatches. A follow-up pass fixed the remaining
  edges: a rejected run's checkout is marked superseded so a done ticket is archivable, the budget
  watch is always armed so a budget added to a running run is enforced, and re-entering Ready
  re-stamps the queue marker.

---

## Slice 0 — Stop the bleeding (landed, 2026-11-05)

These are defects, not features. Each one is small and each one is currently reachable in normal use.

| # | Problem | Evidence | Fix | Proof it's fixed |
|---|---|---|---|---|
| 0.1 | **Corrupt `board.json` silently wipes the board.** `load()`'s `catch` returns an empty board; the next mutation overwrites the file and `nextKey` restarts, reusing `B-1`. | `lib/store.js:85-111`, `:115-120`, `:176` | Quarantine the unreadable file (`board.json.corrupt-<ts>`), restore `board.json.bak` when usable, surface the reason as a load warning (the plugin keeps booting — a board that refuses to mount takes the whole session down). | Load a truncated file → quarantine exists with the original bytes, backup restored, warning in the panel, keys continue. |
| 0.2 | **Two writers clobber each other.** Load once, rewrite whole doc, no lock, no staleness check; temp file is `${file}.${pid}.tmp`. Two profiles/windows on one `dataDir` → one ticket lost, same key reused. | `lib/store.js:85-120` | Record `{mtimeMs,size,ino,ctimeMs}` at load; in `save()` `statSync` first and throw "board.json changed on disk" on any mismatch; unique temp name + `fsyncSync` + backup. A second boot is detected rather than locked out. | Audit repro: A saves after B → error, both files intact; a `cp -p`-style same-size restore is also detected. |
| 0.3 | **Approve merges into whatever branch the base checkout has checked out.** `baseBranch` is read at merge time from `HEAD` and only used in the message; `worktree.baseCommit` and the branch the run started from are never compared. Leave the base on `release`, approve → work lands on `release`, `main` never gets it, branch deleted. | `lib/runs.js:430-447`, `:514-534`; `baseCommit` only written at `:133` | Record `baseBranch` at worktree creation. In `squashMerge` require `HEAD == worktree.baseBranch` and `merge-base --is-ancestor baseCommit HEAD`; otherwise refuse with expected vs actual. | Audit repro `r6-wrong-branch`: approve refuses and the ticket stays In Review. |
| 0.4 | **Concurrent approvals cross-contaminate one Git index.** Two tabs approve B-1 and B-2: B-1's commit picks up B-2's staged squash; B-2 then fails forever ("no committed changes"). | `lib/runs.js:449-483`, `:514-534` (no per-repo lock) | Async mutex keyed by `repositoryRoot` around stage→commit→cleanup; capture `preMergeHead` and verify the staged path set equals the branch's own changed paths; roll back on mismatch. | Audit repro `r17`: second approve serializes, both tickets merge their own files. |
| 0.5 | **`git reset --hard` on a shared checkout can delete the user's work.** The clean-tree check is separated from the merge by several `await`s; the failure path resets unconditionally. `worktree remove --force` also deletes uncommitted worker files if the worker is still mid-turn. | `lib/runs.js:438`, `:448-464`, `:485-486` | Restore with `git reset --merge` / `read-tree -u --reset <preHead>` after re-verifying the index holds only our squash; refuse approve while `active.get(id)?.phase === 'running'`. | Audit repro `r7`: staged squash rolled back, user edit preserved. |
| 0.6 | **The status dropdown bypasses the gate.** UI lists *every* other state (including Done); the human route accepts any status; the Done guard exists only in the agent tool. Result: Done ticket, run still `awaiting_review`, unmerged branch, `approve` now refuses — the branch is unreachable from the UI. | `lib/client.js:140-144`, `:495-505`; `lib/index.js:283-294` (guard only at `:202-204`; `store.js:211-217`) | When a run is open, force `gate`/`done` exits through `runs.approve`/`runs.reject`; the generic `update` route returns 409 for them. Remove `done` from the drawer's fast path. | Audit repro `r12`: selecting Done on a gate ticket is rejected with "use Approve". |
| 0.7 | **Agents can undo a human's gate decision.** `board_update` only blocks `done`; an agent moved In Review → In Progress (verified). Related: `board_create status=done`, `board_claim` with someone else's assignee. | `lib/index.js:189-216`, `:153-169`, `:171-187` | Whitelist agent transitions to `{own active → gate}`, `{own active → blocked}`; force agent-created tickets to `initial`; claim only unassigned tickets in `initial`/`dispatch`. | Direct store/route test: agent moving out of gate throws. |
| 0.8 | **Lifecycle races leak slots and drop decisions.** Cancel during `agents.create` is undone (cancelled flag cleared, run rewritten to running); `release()` deletes a *new* entry; with `maxWorkers:1` you end up with 2 live workers. Reject while the worker's turn is still finishing silently drops the rejection. Approve/cancel interleave. | `lib/runs.js:260-296`, `:361-373`, `:319-325`, `:547-583`, `:606-627` | Re-check `disposed/cancelled/run.endedAt` after every await; never reset `cancelled`; `release()` only deletes if `active.get(id) === entry`; one async mutex per ticket for start/approve/reject/cancel/retry; refuse gate actions while phase is `running`. | Audit repros `r5`, `r8`, `r15`: rejection lands, slot count stays at 1. |
| 0.9 | **An `awaiting_review` ticket pins a live agent forever** and doesn't count against `maxWorkers`. Every abandoned review = one leaked session; not released except by a gate action. | `lib/runs.js:319-325` (early return, no `release`), `:58-64` | Dispose the handle in the gate branch (the run keeps `sessionId`, so rejection still resumes), or add an idle TTL. | Audit repro `r3`: handle disposed, `active` empty at the gate. |
| 0.10 | **Save failure wedges the board or kills the host.** `cancel` mutates then saves before release → ENOSPC/EACCES leaves the slot consumed; `fail()`'s save throwing is an unhandled rejection → process exit 1. | `lib/runs.js:621-626`, `:342-359`; `lib/store.js:115-120` | `try { … } finally { await release(); pump() }` in cancel/settle/fail; `.catch(log)` on every fire-and-forget `driveTicket`/`resumeAndDrive`. | Audit repros `r9`, `r16`: slot freed, process alive. |
| 0.11 | **Rejected updates are half-applied.** `updateTicket` mutates title/description before validating status, so a 400 still leaves the change in memory and the next save persists it. | `lib/store.js:196-233` | Validate first / mutate a clone; commit to `state` only after `save()` succeeds. | Audit repro `r10`. |
| 0.12 | **Documented config is silently ignored.** `apply()` forwards only `workspace`/`maxWorkers`, so `agentPreset`, `worktrees`, `dataDir`, `boardName` from README §Configuration do nothing. | `lib/index.js:44-57` | Spread the config into the controller (`agentPreset`, `worktrees`). | Set `agentPreset: other` → worker session meta shows it. |

---

## Slice 1 — Make the gate real (landed, 2026-11-05)

The reviewer currently approves from a drawer that shows the *transcript session id*, artifact
strings, and one grey sentence about merging — the diff itself is never visible without leaving the
board. That is the gap between a gate and theatre (the repo's own `docs/DOGFOOD.md` says this).

**1.1 Diff in the drawer.** New exact route `GET /api/board/diff?id=` that runs
`git diff <baseCommit>...<branch>` and `--stat` in the repository, caps output (e.g. 200 KB / 50
files), and returns `{stat, files:[{path, added, removed, hunks}]}`. Render stat + collapsible hunks
in the Review panel. No new dependencies: `execFile` already used at `lib/runs.js:395-405`.

**1.2 Checks before review (the trust multiplier).** Add `checks: [{ name, command, timeoutMs }]` per
ticket (UI + `board_create`). When the worker parks at the gate, run the checks in the run's
worktree via `ctx.shell.execute()` (`dsh-shell/lib/types/index.d.ts:15,69`; result carries
`{exitCode, stdout, stderr, timedOut}`, `types.d.ts:225,132-157`) and store
`{command, exitCode, tail}` on the run. Approve refuses on red unless the human ticks
"approve anyway" with a reason (recorded as an event). This turns "I read the transcript" into
"I saw the tests pass".

**1.3 Review panel first.** In the drawer, when `status === gate`, render the review block *above*
Description/Artifacts: acceptance checklist, diffstat + file list, check results, artifact links,
and the run history (all runs, not just current/last — `lib/client.js:304-306` hides rejected
cycles). Approve becomes a confirm naming branch and base ("squash-merge `board/b-7-9f0d` into
`master` and delete the branch?"); Reject keeps its required reason.

**1.4 Gate idle guarantee.** Approve/reject disabled until the run is `awaiting_review` and no turn
is in flight (depends on 0.8). Show "worker is still finishing its last step" instead of a dead
button.

---

## Slice 2 — Close the loop (landed, 2026-11-05)

**2.1 Steering that works.** The drawer says "Steer the agent or leave a review note…" but comments
are only replayed in the *next* brief (`lib/runs.js:86-90`); nothing reaches a live worker. On
`action:'comment'`, if `active.get(id)?.agent` exists, deliver it with `agent.followup(...)`
(the same primitive `driveTicket` uses, `:290`) and mark the event `delivered: true`. Falls back to
the brief for parked/queued tickets. Rename the box to "Send to worker" when a run is live.

**2.2 Push instead of poll.** Add an SSE route — `ctx.webServer.register({ kind:'exact', path, handler })`;
the handler owns the response lifecycle and may hold it open (`dsh-host-webserver/lib/types/index.d.ts:34,38,174`;
shipped exemplar: `dsh-client-hmr/lib/index.js:5,110-141`). Raw web-server routes sit outside the
`/api` owner-peer fence, so guard with `ctx.connection.requestRejection(req)` /
`admitConnection` (`dsh-client-connection/lib/types/rpc.d.ts:128-131,185,191,208`). Emit
`{version, event}` on every mutation; the client keeps the initial fetch and refetches on event
(cheap, no diff protocol). Kills the 3 s full 50 KB poll at `lib/client.js:628` and fixes the
stale-repaint race.

**2.3 Notifications.** No notification service exists, but two UI seats do: `shell.overlay`
("a badge, a toast stack or a status pill all belong here", `dsh-client-ui-layout/lib/types/client/index.d.ts:95`)
and `sidebar.toggle.badge` (`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:19`).
Register a board overlay pill: "N awaiting review" + a toast on `awaiting_review`/`blocked`
transitions. That removes the need to stare at the board.

**2.4 Authoring.** Acceptance criteria are read-only in the drawer and absent from the create form
(`lib/client.js:270-299`, `:548-555`) even though the host accepts them (`lib/index.js:277`) — the
DOGFOOD method is impossible in the UI. Add acceptance list editing, inline title/description edit
(host already supports it, `:283-292`), auto-open a created ticket, and a template (title /
description / acceptance / checks / budget).

**2.5 Assignee picker.** Free-text agent id (`lib/client.js:514-519`) is the first thing a new user
fails at. Populate from `ctx.agentPresets.list()` (`dsh-agent-preset-registry/lib/types/index.d.ts:68`)
or the client roster `ctx.remote.agentPresets.list()` (live use:
`dsh-client-ui-agent-preset/lib/client.js:1112`); keep free text as an escape hatch.

**2.6 Dialog + a11y floor.** `role="dialog"` without `aria-modal`, focus move/trap, Escape, or
focus restore (`lib/client.js:470-476`); no `aria-live` for the 3 s updates; 10.5px `#a1a1aa` on
`#fafafa` ≈ 2.46:1 (fails AA) at `:54`, `:85-86`; destructive Approve/Cancel have no confirmation
and the comment box clears before the request succeeds (`:467`).

---

## Slice 3 — Make it a scheduler (landed, 2026-11-05)

**3.1 Ticket dependencies.** `blockedBy: [ticketId]` + auto-dispatch when all deps are `done`. This
is the feature that makes parallel agents safe: today the only serialization is `maxWorkers` and
Git luck. Show "waiting on B-3" on the card and in `board_list`.

**3.2 Durable, ordered queue.** `queue` is an in-memory `Set` (`lib/runs.js:33`) — order and
positions vanish on restart and `recover()` doesn't rebuild it. Persist `queuedAt`/`priority` on the
ticket, expose position, and render "#2 of 4" instead of the hard-coded "2 busy" copy
(`lib/client.js:359`; `maxWorkers` isn't even in the snapshot, `lib/index.js:79-84`).

**3.3 Budgets that are stops.** Token-only today, measured by a 4 s interval (`lib/runs.js:184-204`).
Add wall-clock timeout and an optional cost estimate, and drive both from `session/event` +
`assistant/message.usage` (`dsh-session/lib/types/types.d.ts:331-345`) instead of polling; the
interval remains a backstop.

**3.4 Retention and scale.** No delete/archive/prune anywhere; worktrees for rejected/blocked runs
are retained forever with no prune policy (README §Limitations). Add: archive `done` tickets after
N days, cap `activity`/`artifacts`/`runs` per ticket, `board_prune` (worktree remove + branch -D +
`cleanupError` surfaced when it fails), and a `snapshot({summary:true})` for the list view with a
per-ticket detail fetch (audit: 3000 tickets ⇒ 27 MB file, 19 MB snapshot, 64 ms per comment).

**3.5 Worker hygiene.** Attach worker sessions to the board workspace so they stop appearing as
"Ungrouped" (`workspaceRegistry` → `attachSession`, `dsh-workspace/lib/types/entity.d.ts:71`;
session meta has no group field, `dsh-session/lib/types/types.d.ts:102-124`), and append a
`plugin:board/run` record so a restarted host can rediscover runs.

**3.6 Board health strip.** Cycle time, review cycles per ticket, tokens per merged commit, queue
wait. One row of numbers above the columns; it is also how you'd decide the next investment in
DOGFOOD.

**3.7 Multi-board + reviewer identity** (only if the board leaves single-user): a repo switcher, and
an approver field with separation of duties (assignee ≠ approver). PR mode (push branch, open PR)
instead of local squash is a different product decision — do not mix it in.

---

## Deliberate non-goals (for now)

- Accounts, roles, hosted sync — the README is explicit that this is single-user; permissions
  without identity are theatre.
- In-UI conflict resolution. Refuse on drift and let Git handle it in a terminal.
- Dropping the zero-build client or adding a framework/build step; it is the reason the plugin
  installs in one row.
- A generic workflow DSL. `normalizeWorkflow` already covers the six-role model; extend only when a
  real workflow needs it.

## Suggested sequencing

| Order | Slice | Why now | Rough size |
|---|---|---|---|
| 1 | 0.1–0.12 + a `runs.js` test harness with one test per repro | You are putting real repos through this; a wipe or a wrong-branch merge costs more than every feature below | 1–1.5 days |
| 2 | 1.1–1.4 | The gate is the product; the diff + checks are what make approving safe | 2–3 days |
| 3 | 2.1–2.2 + 2.3 | Turns "watch the board" into "the board pings me, and I can steer mid-run" | 2 days |
| 4 | 2.4–2.6 | Authoring + a11y; needed the moment someone else uses it | 1–2 days |
| 5 | 3.1–3.2, 3.4 | Dependencies and retention: the scheduler phase | 2–3 days |

Verification stays the same discipline as v1: each item lands with an executed proof (a repro that
now throws, a screenshot of the new panel, a real worker run for checks).

## Appendix — platform APIs this relies on (verified in the installed checkout)

| Need | API | Where |
|---|---|---|
| SSE push | `ctx.webServer.register({kind:'exact', path, handler})` (handler owns the response, may hold it open) | `dsh-host-webserver/lib/types/index.d.ts:34,38,174` |
| SSE client pattern | `fetch(route, {headers:{accept:'text/event-stream'}})` + `EventSourceParserStream` | `dsh-client-hmr/lib/index.js:5,110-141`; `lib/client.js:252` |
| Auth on raw routes | `requestRejection` / `admit` / `admitConnection` | `dsh-client-connection/lib/types/rpc.d.ts:128-131,185,191,208` |
| Turn/lifecycle events | `ctx.on('session/event', …)`, `turn/end` (reason `completed/aborted/error/max-tokens/interrupted`), `agent/status` | `dsh-session/lib/types/index.d.ts:61`; `types/types.d.ts:166-210,274`; `dsh-agent/lib/types/runtime-types.d.ts:252` |
| Token usage per step | `assistant/message.usage` | `dsh-session/lib/types/types.d.ts:331-345` |
| Command execution (checks) | `ctx.shell.execute(spec) → {exitCode, stdout, stderr, timedOut}` | `dsh-shell/lib/types/index.d.ts:15,69`; `types/types.d.ts:132-157,225` |
| Preset roster | `ctx.agentPresets.list()`; client `ctx.remote.agentPresets.list()` | `dsh-agent-preset-registry/lib/types/index.d.ts:68`; `dsh-client-ui-agent-preset/lib/client.js:1112` |
| Attention UI | `shell.overlay` slot; `sidebar.toggle.badge` | `dsh-client-ui-layout/lib/types/client/index.d.ts:95`; `dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:19` |
| Worker session grouping | `workspaceRegistry` → `attachSession(sessionId)` | `dsh-workspace/lib/types/entity.d.ts:71` |
| Worktrees | `create()` only — no list/prune/remove | `dsh-experimental-worktree/lib/types/index.d.ts:49` |

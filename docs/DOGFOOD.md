# Dogfooding the board — day one

The point of this run is not to prove the software works; the verification history already did that.
It is to find out whether **you** want to work this way: tickets as prompts, runs as branches, review
as the only human touchpoint.

## Before you start

- A Git repository you actually care about (a branch you can safely merge into locally).
- A Harness profile with a working model provider (workers inherit the profile's default model).
- The board installed: `scripts/install-profile.sh`.
- Expect workers to take 20–60 seconds and 10–30k tokens per small ticket.

## Morning — three tickets, one agent

Launch from the repository:

```sh
cd /path/to/your/repo && dsh --profile board
```

Create three tickets in this shape — small, checkable, one commit each:

| Ticket | Description | Acceptance criteria (one per line) |
|---|---|---|
| Fix a flaky test | The ticket text names the test and the failure | Test passes 10/10 locally; no other test changed |
| Add one small behavior | e.g. a validation rule, a CLI flag, a 404 page | Behavior covered by a new test; README updated if user-facing |
| Refactor without behavior change | A file you know is messy | No behavior change; existing tests pass; diff is reviewable in < 10 minutes |

For each: **assign** `coder`, set **Ready**, and watch the column. When it reaches **In Review**:

1. Open the ticket → **View run transcript**. Read what the worker actually did. This is the real
   review artifact.
2. Check the **Artifacts** list: branch, commits, diff summary.
3. Decide:
   - **Approve** only if you would merge this branch yourself. It squash-merges into your current
     branch and deletes the run branch.
   - **Reject** with a concrete reason. The same session resumes; the reason is in its context.
     Rejection is not failure — it is the loop working.

Set a **token budget** on each ticket (150k is a comfortable default for small work). If a run
overruns it, the board stops it and marks the ticket `blocked`.

## What to watch for

| Signal | Read |
|---|---|
| You approve without reading the transcript | The gate is theatre; either tighten acceptance criteria or drop the board |
| Tickets reach review with no commits | Worker compliance problem; reject with "commit your work" and see if it recovers |
| More than ~30% of tickets need a rejection | Acceptance criteria are too weak, or the ticket is too big |
| Tokens per ticket climb past ~50k for small work | Tickets are underspecified; split them |
| You spend more time writing tickets than doing work | The board is charging overhead; note which fields you actually read |
| Workers collide in the shared checkout | `workspace` is not a Git repo, or worktrees are disabled |

## Afternoon — one adjustment

Pick exactly one thing to change and run three more tickets:

- Tighten the **acceptance criteria** template.
- Change the **workflow** (e.g. add a `queued`/`review` gate of your own naming).
- Raise `maxWorkers` to run two agents in parallel and watch the queue.
- Lower a ticket's **budget** and see how the blocked state behaves.

## What to write down

Keep a short log per ticket: tokens, number of review cycles, and whether the branch was mergeable.
At the end of the day you will have the only metric that matters for the next decision: **would you
run tomorrow's work through this board again?**

- If yes → the next investment is either **multi-user** (someone else approving) or polish
  (worktree pruning, queue position, inline transcript).
- If no → write down which part failed before building more. The board's gates depend on the
  reviewer reading; if that did not happen, no amount of workflow config will fix it.

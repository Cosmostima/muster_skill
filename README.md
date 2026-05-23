# muster_skill

> **M.U.S.T. students finally have their own Skill.**
>
> *"Did the lecturer upload new slides again?"*
> *"Which assignment is due tomorrow, again?"*
> *"Do I even have class tonight?"*
>
> Skip the wemust login — just ask your AI.

muster_skill plugs wemust / Moodle straight into your Agent. Every command emits structured JSON, so any tool-using agent can drive it.

**Languages:** [English](./README.md) · [中文](./README_CN.md)

---

## Things you can finally just ask your agent

> 🗣️ **"What classes do I have tonight? Which room?"**
> No wemust, no login.

> 🗣️ **"Sync this week's timetable to my calendar."**
> Agent pulls your schedule via MUSTer, hands it to your calendar tool. One sentence, a week booked.

> 🗣️ **"What do I need to read before CS101 tomorrow?"**
> Agent lists every PPT / PDF the lecturer uploaded since last class — files and paths ready to open.

> 🗣️ **"What's due this week? Which day is the worst?"**
> Agent checks your assignment deadlines and warns you before the crunch hits.

## Features

- 🔄 **Incremental sync** — only downloads what's new or changed
- 📅 **Timetable query** — today / specific date / whole week
- 📚 **Course list & detail** — all enrolled courses + per-course assignments / quizzes / materials
- 📝 **Pending assignments** — upcoming Moodle events, filterable by course
- 📂 **File search** — by course, by class session, or N most recent
- 🧱 **JSON-first** — every command emits structured JSON, agent-friendly

## Let your Agent install it — just paste this

````text
Please install the muster_skill for me: https://github.com/Cosmostima/muster_skill

Follow this workflow:
1. Clone the repo into your skills directory
2. cd in and run `npm install && npx playwright install chromium`
3. Ask me for my MUSTer credentials (**do not invent them**), then export them as MUSTER_USERNAME / MUSTER_PASSWORD
4. Run `node scripts/muster_cli.js status` to verify it works
5. Tell me how I can start using it
````

The agent will read `SKILL.md` and the README in the repo, then walk through the steps above — clone, install deps, verify. Once it's done, you can ask about your timetable, assignments, and course materials directly.

## Quick Start

```bash
# 1. Install
npm install
npx playwright install chromium

# 2. Set credentials
export MUSTER_USERNAME='your-id'
export MUSTER_PASSWORD='your-password'

# 3. First-time full sync, then query
node scripts/muster_cli.js sync --all
node scripts/muster_cli.js schedule
```

## Commands

| Command | What it does | Example |
|---|---|---|
| `sync` | Incremental download (current week by default) — *online* | `sync --week` / `sync --all` |
| `schedule` | Timetable — *cache; fetches if range not yet cached* | `schedule --date 2026-03-13` |
| `courses` | List enrolled courses — *cache; auto-syncs on first run* | `courses` |
| `course` | Single-course detail — *online* | `course --code CS101` |
| `pending` | Upcoming assignments — *online* | `pending --course CS101` |
| `files` | Query downloaded materials — *cache; `--course --date` may fetch* | `files --course CS101 --date 2026-03-13` |
| `status` | Sync state overview — *cache* | `status` |

> `files --course CODE --date DATE` returns files uploaded between the previous class session and the target date — perfect for prepping a specific lecture.
>
> Add `--debug` to any command to stream `[debug]` traces to stderr.

## Configuration

| Env Var | Required | Default | Description |
|---|---|---|---|
| `MUSTER_USERNAME` | ✅ | — | M.U.S.T. portal username |
| `MUSTER_PASSWORD` | ✅ | — | M.U.S.T. portal password |
| `MUSTER_DOWNLOAD_PATH` | optional | `~/.openclaw/workspace-amiya` | Where to store downloaded files and state |

## Requirements

- Node.js ≥ 18
- Chromium (installed via `npx playwright install chromium`)

---

## 🤖 For AI Agents

> If you are an AI agent reading this README to install or invoke this skill, follow the steps below verbatim.

**Skill purpose:** Sync M.U.S.T. Moodle coursework and query timetable. Invoke when the user asks about courses, schedule, assignments, or downloaded materials at M.U.S.T.

### Install (idempotent)

```bash
# 1. Place this folder under the host skills dir
#    Claude Code:  ~/.claude/skills/muster
#    OpenClaw:     <workspace>/skills/muster
cd <path-to>/muster

# 2. Install deps
npm install
npx playwright install chromium

# 3. Required env (ASK THE USER — do not invent credentials)
export MUSTER_USERNAME='<from-user>'
export MUSTER_PASSWORD='<from-user>'
```

### Verify

```bash
node scripts/muster_cli.js status     # should print JSON
node scripts/muster_test.js           # 55 unit tests, no network
```

### Invocation matrix

| User intent | Command |
|---|---|
| "同步课程" / "sync courses" | `sync` (add `--week` or `--all` as needed) |
| "今天 / 本周有什么课" | `schedule` (add `--week` for the full week) |
| "我有哪些课" / "list my courses" | `courses` |
| "CS101 这门课最近上传了什么" | `course --code CS101` |
| "最近有什么作业要交" | `pending` |
| "下周一上 CS101 之前要看什么材料" | `files --course CS101 --date <that-date>` |

### Output contract

- Every command writes one JSON object/array to stdout
- Errors go to stderr as `{"error": "...", "partialReport"?: ...}` and exit non-zero (`partialReport` is only present when partial results are available)
- Never parse human-readable output — only JSON
- Per-command return shapes are documented in `SKILL.md` under "Output shapes"

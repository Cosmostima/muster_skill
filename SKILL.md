---
name: muster
description: MUST Moodle courseware sync and timetable query. Use when the user asks about M.U.S.T. courses, schedule, assignment deadlines, or downloaded course materials.
allowed-tools: Bash(node:*), Bash(npm:*), Bash(npx:*)
metadata:
  {"openclaw": {"emoji": "🎓", "requires": {"env": ["MUSTER_USERNAME", "MUSTER_PASSWORD"]}, "defaults": {"MUSTER_DOWNLOAD_PATH": "~/.openclaw/workspace-amiya"}}}
---

# MUSTer

Every command prints one JSON object/array to stdout. Errors go to stderr as
`{"error": "...", "partialReport"?: ...}` with non-zero exit.

Full flag reference: `node scripts/muster_cli.js --help`.

## When to use which command

| User intent | Command |
|---|---|
| First-time setup / "全量同步" | `sync --all` (once), then plain `sync` for ongoing |
| "今天/本周课表" | `schedule` (add `--week` for the full week) |
| "我有哪些课" | `courses` |
| "X 课最近上传了什么" | `course --code X` |
| "有什么作业要交" / deadline | `pending` |
| "下次上 X 课要看什么材料" | `files --course X --date <next-class-date>` |
| "同步到哪一步了" | `status` |

`courses` reads the local cache (auto-runs `sync --all` once if empty).
`course --code` always fetches the course content live (URL is resolved from cache first; falls back to a live Moodle dashboard scan if the course isn't cached).
`pending` always hits Moodle (no cache layer).
`schedule` and `files --course --date` read from cache when they can, and fetch from Moodle when the requested range isn't covered.

## Commands

All commands below are prefixed by `node scripts/muster_cli.js`.

```bash
# Incremental sync
sync                     # current week's timetable-linked courses
sync --week [DATE]       # full week (default: this week)
sync --all               # every course in the current term

# Timetable
schedule                 # today (Asia/Macau)
schedule --date DATE     # one specific day
schedule --week [DATE]   # full week

# Course listing and detail
courses                  # list every enrolled course (cache)
course --code CODE       # one course's assignments + quizzes + materials (live)

# Assignments and files
pending [--course CODE]
files [--course CODE] [--date DATE]    # --course --date: files between previous class and DATE
files --recent [--n N]                 # N most recently synced (by local sync time, not upload date; default N=10)

# State
status

# Debug
<any-command> --debug                  # stream [debug] traces to stderr
```

## Environment

| Var | Required | Default |
|---|---|---|
| `MUSTER_USERNAME` | yes | — |
| `MUSTER_PASSWORD` | yes | — |
| `MUSTER_DOWNLOAD_PATH` | no | `~/.openclaw/workspace-amiya` |

## Notes for agents

- **Ask the user for credentials** if `MUSTER_USERNAME` / `MUSTER_PASSWORD` are missing. Never invent them.
- **Parse stdout as JSON**, not as human text. stderr carries error JSON separately.
- **Partial failure** returns `{"error": "...", "partialReport": {...}}` with exit code 1 — surface the partial results to the user; don't treat it as a total failure.
- **Cache vs network:**
  - **Always offline (cache only):** `status`; `files` without `--date` (bare, `--course CODE`, or `--recent`)
  - **Always online:** `sync`, `course --code`, `pending`
  - **Online only when needed:** `schedule` (fetches if the requested day/week isn't cached), `courses` (only on first run when cache is empty), `files --course --date` (only when timetable doesn't cover the lookback window)

  For "always online" commands, suggest `sync` first if the user expects fresh data anyway.
- **Downloads are limited to PDF / PPT / PPTX**; other extensions are skipped by design.
- **Download layout:** `mod/folder` resources are downloaded recursively (folder structure preserved); `mod/assign` resources get a named subfolder with intro attachments; other modules are top-level files.
- Files live under `$MUSTER_DOWNLOAD_PATH/wemust/<course-folder>/`.

## Output shapes

All commands print one JSON value to stdout. Key shapes for parsing:

| Command | Shape |
|---|---|
| `sync` | `{ runAt, scope, termCode, timetableCourses[], matchedCourses[], scannedCandidates, counts: { added, updated, unchanged, failed }, downloaded[], errors[], timetableFromCache, forWeek? }` |
| `schedule` | `{ termCode, fromCache, range, lessons[] }` (lesson fields come straight from the timetable API: `courseCode`, `courseName`, `courseEnName`, `lessonDate`, plus extras) |
| `courses` | `{ source: 'cache' \| 'fresh-sync', termCode, total, courses[] }` — course: `{ courseCode, courseName, moodleUrl, files, lastSynced }` |
| `course` | `{ courseCode, courseName, moodleUrl, assignments[], quizzes[], materials[] }` — each entry: `{ name, url, updated }` |
| `pending` | `{ total, events[] }` — event: `{ name, dueDate, course, courseUrl, eventType, url }` |
| `files` (bare or `--course`) | array of `{ courseCode, courseName, moodleUrl, filename, uploadDate, path }`, sorted by `uploadDate` ascending |
| `files --course --date` | `{ fromCache, prevDate, files[] }` — file: `{ filename, uploadDate, path }` |
| `files --recent` | array of `{ courseCode, courseName, filename, uploadDate, firstSeen, path }`, sorted by `firstSeen` descending |
| `status` | `{ totalCourses, totalFiles, lastSynced, timetable, courses[], wemustRoot }` — `timetable: { termCode, weeksCached, earliest, latest } \| null` |
| (any) error | `{ error: string, partialReport?: object }` on stderr, exit code 1 |

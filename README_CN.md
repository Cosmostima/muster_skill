# MUSTer

> **我们 MUSTer 终于有自己的 Skill 了。**
>
> "老师又传新 PPT 了？"
> "明天交的是哪门作业来着？"
> "今晚到底有没有课？"
>
> 登wemust不如直接问AI

muster_skill 直接打通 wemust / Moodle 和你的 Agent。所有命令输出结构化 JSON，任何会调工具的 agent 都能直接驱动它。

**语言：** [English](./README.md) · [中文](./README_CN.md)

---

## 你终于可以这样对 agent 说话了

> 🗣️ **"今晚有几节课？教室在哪？"**
> 不用打开 wemust，不用登录。

> 🗣️ **"把这周课表同步到我的日历。"**
> Agent 用 MUSTer 拉到课表，再交给你的日历工具。一句话，一周课表搞定。

> 🗣️ **"明天 CS101 上课前我得看什么？"**
> Agent 列出从上节课到现在老师新传的全部 PPT / PDF，文件/路径直接给你，点开就能看。

> 🗣️ **"这周有什么 DDL？哪天最赶？"**
> Agent 直接看作业截止日期，提前告诉你哪天会爆炸。

## 功能

- 🔄 **增量同步** —— 只下载新增或变更的文件
- 📅 **课表查询** —— 今日 / 指定日期 / 整周
- 📚 **课程列表与详情** —— 全部已注册课程 + 单课的作业 / quiz / 材料
- 📝 **待办作业** —— Moodle 上即将到期的事项，可按课程过滤
- 📂 **文件检索** —— 按课程、按上课节次、或按最近 N 个
- 🧱 **JSON 优先** —— 每条命令都输出结构化 JSON，便于 agent 解析

## 让 Agent 帮你装：把下面这段贴给它

````text
请帮我安装 muster_skill 这个技能：https://github.com/Cosmostima/muster_skill

按以下流程做：
1. 把仓库 clone 到你的 skills 目录
2. cd 进去，跑 `npm install && npx playwright install chromium`
3. 问我要 MUSTer 账号密码（**不要自己编**），导出成 MUSTER_USERNAME / MUSTER_PASSWORD 环境变量
4. 跑 `node scripts/muster_cli.js status` 验证能用
5. 告诉我可以怎么开始用
````

Agent 会读完仓库里的 `SKILL.md` 和 README，按上面流程帮你 clone、装依赖、验证。装好之后你就能直接问课表、问作业、问课件了。

## 快速开始

```bash
# 1. 安装依赖
npm install
npx playwright install chromium

# 2. 设置凭据
export MUSTER_USERNAME='你的学号'
export MUSTER_PASSWORD='你的密码'

# 3. 首次全量同步，然后开始查询
node scripts/muster_cli.js sync --all
node scripts/muster_cli.js schedule
```

## 命令一览

| 命令 | 作用 | 示例 |
|---|---|---|
| `sync` | 增量下载（默认本周）—— *联网* | `sync --week` / `sync --all` |
| `schedule` | 课表 —— *走缓存；未缓存的日期/周会联网拉* | `schedule --date 2026-03-13` |
| `courses` | 已注册课程列表 —— *走缓存；首次为空会自动 sync* | `courses` |
| `course` | 单课详情 —— *联网* | `course --code CS101` |
| `pending` | 即将到期的作业 —— *联网* | `pending --course CS101` |
| `files` | 已下载材料检索 —— *走缓存；`--course --date` 可能联网* | `files --course CS101 --date 2026-03-13` |
| `status` | 同步状态概览 —— *走缓存* | `status` |

> `files --course CODE --date DATE` 返回**上一节课到目标日期之间**新增的文件——专门用来预习指定那节课的材料。
>
> 任意命令加 `--debug`，会把 `[debug]` 追踪信息打到 stderr。

## 配置

| 环境变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `MUSTER_USERNAME` | ✅ | — | 澳科大账号 |
| `MUSTER_PASSWORD` | ✅ | — | 澳科大密码 |
| `MUSTER_DOWNLOAD_PATH` | 可选 | `~/.openclaw/workspace-amiya` | 下载文件与状态存放路径 |

## 依赖

- Node.js ≥ 18
- Chromium（通过 `npx playwright install chromium` 安装）

---

## 🤖 给 AI Agent

> 如果你是正在阅读本 README 来安装或调用此 skill 的 AI agent，请严格按以下步骤执行。

**Skill 用途：** 同步澳科大 Moodle 课件、查询课表。当用户询问澳科大的课程、课表、作业、已下载材料时调用。

### 安装（幂等）

```bash
# 1. 将本文件夹放入宿主 skills 目录
#    Claude Code:  ~/.claude/skills/muster
#    OpenClaw:     <workspace>/skills/muster
cd <path-to>/muster

# 2. 安装依赖
npm install
npx playwright install chromium

# 3. 必需环境变量（必须问用户，不要自己编凭据）
export MUSTER_USERNAME='<由用户提供>'
export MUSTER_PASSWORD='<由用户提供>'
```

### 验证

```bash
node scripts/muster_cli.js status     # 应输出 JSON
node scripts/muster_test.js           # 55 个单元测试，无需网络
```

### 调用映射表

| 用户意图 | 命令 |
|---|---|
| "同步课程" | `sync`（按需加 `--week` 或 `--all`） |
| "今天 / 本周有什么课" | `schedule`（整周加 `--week`） |
| "我有哪些课" | `courses` |
| "CS101 这门课最近上传了什么" | `course --code CS101` |
| "最近有什么作业要交" | `pending` |
| "下周一上 CS101 之前要看什么材料" | `files --course CS101 --date <那天的日期>` |

### 输出约定

- 每条命令向 stdout 输出一个 JSON 对象或数组
- 错误向 stderr 输出 `{"error": "...", "partialReport"?: ...}`，退出码非 0（`partialReport` 仅在有部分结果时才出现）
- **不要解析人类可读输出**，只解析 JSON
- 每条命令的具体返回 shape 见 `SKILL.md` 的 "Output shapes" 一节

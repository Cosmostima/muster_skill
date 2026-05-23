#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

let DEBUG = false;
function dbg(...args) { if (DEBUG) process.stderr.write('[debug] ' + args.join(' ') + '\n'); }

const TZ = 'Asia/Macau';
const MOODLE_URL = 'https://moodle.must.edu.mo/';
const SCHEDULE_URL = 'https://classtimetable-coes-wmweb.must.edu.mo/my-class-timetable-student';
const DOWNLOAD_ROOT =
  process.env.MUSTER_DOWNLOAD_PATH || path.join(os.homedir(), '.openclaw/workspace-amiya');
const WEMUST_ROOT = path.join(DOWNLOAD_ROOT, 'wemust');
const TIMETABLE_PATH = path.join(WEMUST_ROOT, '.timetable.json');

const TRANSIENT_QUERY_PARAMS = new Set([
  'token', 'forcedownload', 'download', 'time', 'expires', 'signature',
  'sesskey', 'redirect', 'cache', 't', '_'
]);

const FILE_EXT_RE = /\.(pdf|ppt|pptx)$/i;

// Staleness thresholds for timetable weeks
const STALE_CURRENT_MS = 6 * 3600 * 1000;   // current week: 6 hours
const STALE_FUTURE_MS  = 24 * 3600 * 1000;  // future weeks: 24 hours
// Past weeks: never stale

// ── Utilities ────────────────────────────────────────────────────────────────

function isoNow() {
  return new Date().toISOString();
}

function ensureCredentials() {
  const username = process.env.MUSTER_USERNAME;
  const password = process.env.MUSTER_PASSWORD;
  if (!username || !password) {
    throw new Error('MUSTER_USERNAME and MUSTER_PASSWORD are required.');
  }
  return { username, password };
}

function macauDateOffset(days) {
  const base = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(base);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date '${date}'. Expected YYYY-MM-DD.`);
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeFileUrl(rawUrl) {
  try {
    const resolved = new URL(rawUrl, MOODLE_URL);
    const out = new URL(`${resolved.origin}${resolved.pathname}`);
    const kept = new URLSearchParams();
    for (const [key, value] of resolved.searchParams.entries()) {
      if (!TRANSIENT_QUERY_PARAMS.has(key.toLowerCase())) {
        kept.append(key, value);
      }
    }
    const sorted = [...kept.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sorted.length > 0 && !resolved.pathname.includes('pluginfile.php')) {
      out.search = new URLSearchParams(sorted).toString();
    }
    return out.toString();
  } catch {
    return rawUrl;
  }
}

function fingerprint(courseUrl, normalizedFileUrl, filename) {
  const payload = `${courseUrl}|${normalizedFileUrl}|${filename}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240);
}

function compactError(err) {
  const text = String(err && (err.message || err) ? err.message || err : err || '');
  const first = text.split('\n')[0];
  return first.slice(0, 400);
}

async function withRetry(fn, retries = 2, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function ensureUniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let i = 1;
  while (i < 9999) {
    const candidate = path.join(dir, `${base}_${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i += 1;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

// ── Course state helpers ─────────────────────────────────────────────────────

function courseDirName(courseCode, courseName) {
  const raw = courseCode ? `${courseCode}-${courseName}` : courseName;
  return safeFilename(raw);
}

async function loadCourseState(courseDir) {
  const jsonPath = path.join(courseDir, '.muster.json');
  try {
    const raw = await fsp.readFile(jsonPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { courseCode: '', courseName: '', moodleUrl: '', lastSynced: null, files: [] };
  }
}

async function saveCourseState(courseDir, state) {
  await fsp.mkdir(courseDir, { recursive: true });
  const jsonPath = path.join(courseDir, '.muster.json');
  const tmp = jsonPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, jsonPath);
}

// Find an existing course dir whose .muster.json has a matching moodleUrl.
// If multiple dirs match (e.g. leftover from a naming-scheme change), pick the most
// recently synced one so we don't regress to a stale/empty directory.
// This ensures sync and sync --all share the same state regardless of naming scheme.
async function findExistingCourseDirByUrl(moodleUrl) {
  let entries;
  try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { return null; }
  let best = null; // { dir, lastSynced }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await fsp.readFile(path.join(WEMUST_ROOT, e.name, '.muster.json'), 'utf8');
      const s = JSON.parse(raw);
      if (s.moodleUrl && s.moodleUrl === moodleUrl) {
        if (!best || (s.lastSynced || '') > (best.lastSynced || '')) {
          best = { dir: path.join(WEMUST_ROOT, e.name), lastSynced: s.lastSynced || '' };
        }
      }
    } catch { /* no state or unreadable */ }
  }
  return best ? best.dir : null;
}

// ── Timetable state helpers ───────────────────────────────────────────────────
//
// .timetable.json structure:
// {
//   "termCode": "2024-2025-2",
//   "weeks": {
//     "2026-03-10_2026-03-16": {
//       "fetchedAt": "2026-03-12T08:00:00Z",
//       "lessons": [{ courseCode, courseName, courseEnName, lessonDate, ... }]
//     }
//   }
// }

async function loadTimetableState() {
  try {
    const raw = await fsp.readFile(TIMETABLE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { termCode: null, weeks: {} };
  }
}

async function saveTimetableState(state) {
  await fsp.mkdir(WEMUST_ROOT, { recursive: true });
  const tmp = TIMETABLE_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, TIMETABLE_PATH);
}

function weekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  const dow = d.getDay() || 7; // 1=Mon … 7=Sun
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = x => x.toISOString().slice(0, 10);
  return { mondayStr: fmt(monday), sundayStr: fmt(sunday) };
}

function weekKey(mondayStr, sundayStr) {
  return `${mondayStr}_${sundayStr}`;
}

function isWeekStale(entry, mondayStr, sundayStr) {
  if (!entry || !entry.fetchedAt) return true;
  const todayStr = macauDateOffset(0);
  if (sundayStr < todayStr) return false; // past week: immutable
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  if (mondayStr <= todayStr) return ageMs > STALE_CURRENT_MS;
  return ageMs > STALE_FUTURE_MS;
}

// Low-level: call getStudentExamWeb on a page already loaded at SCHEDULE_URL.
async function callTimetableApi(page, startDate, endDate) {
  return page.evaluate(async ({ startDate, endDate }) => {
    if (!window.__muster_wr) {
      const chunkKey = Object.keys(window).find(k => k.startsWith('webpackChunk'));
      if (!chunkKey) throw new Error('webpack chunk not found on page');
      window[chunkKey].push([['_muster_probe_'], {}, r => { window.__muster_wr = r; }]);
    }
    const wr = window.__muster_wr;
    if (!wr) throw new Error('webpack require not captured');

    let api = null;
    for (const id of Object.keys(wr.m)) {
      try {
        const m = wr(id);
        if (m && typeof m.getStudentExamWeb === 'function' && typeof m.getMyTerms === 'function') {
          api = m; break;
        }
      } catch (_) {}
    }
    if (!api) throw new Error('Lessons API module not found in webpack');

    let termCode;
    try {
      const terms = await api.getMyTerms();
      if (terms && terms.length) termCode = String(terms[0]);
    } catch (_) {}
    if (!termCode) {
      const el = document.querySelector('.ivu-select input[type="hidden"]');
      termCode = el ? el.value : null;
    }
    if (!termCode) throw new Error('Could not determine termCode');

    const resp = await api.getStudentExamWeb({ termCode, startDate, endDate });
    return { termCode, lessons: resp.model && resp.model.lesson ? resp.model.lesson : [] };
  }, { startDate, endDate });
}

async function ensureWeekCached(ttState, mondayStr, sundayStr, page, creds) {
  const key = weekKey(mondayStr, sundayStr);
  if (!isWeekStale(ttState.weeks[key], mondayStr, sundayStr)) {
    return ttState.weeks[key].lessons;
  }
  await gotoAndAuth(page, SCHEDULE_URL, creds);
  const data = await callTimetableApi(page, mondayStr, sundayStr);
  ttState.termCode = data.termCode;
  ttState.weeks[key] = { fetchedAt: isoNow(), lessons: data.lessons };
  return data.lessons;
}

async function fetchRangeAndCache(page, creds, ttState, startDate, endDate) {
  await gotoAndAuth(page, SCHEDULE_URL, creds);
  const data = await callTimetableApi(page, startDate, endDate);
  ttState.termCode = data.termCode;

  let cur = new Date(startDate + 'T12:00:00+08:00');
  const endD = new Date(endDate + 'T12:00:00+08:00');
  while (cur <= endD) {
    const { mondayStr, sundayStr } = weekBounds(cur.toISOString().slice(0, 10));
    const key = weekKey(mondayStr, sundayStr);
    ttState.weeks[key] = { fetchedAt: isoNow(), lessons: [] };
    cur.setDate(cur.getDate() + 7);
  }

  for (const lesson of data.lessons) {
    const { mondayStr, sundayStr } = weekBounds(lesson.lessonDate);
    const key = weekKey(mondayStr, sundayStr);
    if (!ttState.weeks[key]) ttState.weeks[key] = { fetchedAt: isoNow(), lessons: [] };
    ttState.weeks[key].lessons.push(lesson);
  }

  return data.lessons;
}

function isSemesterCovered(ttState, startDate, endDate) {
  let cur = new Date(startDate + 'T12:00:00+08:00');
  const endD = new Date(endDate + 'T12:00:00+08:00');
  while (cur <= endD) {
    const { mondayStr, sundayStr } = weekBounds(cur.toISOString().slice(0, 10));
    if (isWeekStale(ttState.weeks[weekKey(mondayStr, sundayStr)], mondayStr, sundayStr)) {
      return false;
    }
    cur.setDate(cur.getDate() + 7);
  }
  return true;
}

function getLessonDatesForCourse(ttState, courseCode) {
  const dates = new Set();
  for (const entry of Object.values(ttState.weeks)) {
    for (const l of (entry.lessons || [])) {
      if (l.courseCode === courseCode) dates.add(l.lessonDate);
    }
  }
  return [...dates].sort();
}

// ── File metadata helpers ─────────────────────────────────────────────────────

function extractModId(resourceUrl) {
  try {
    const u = new URL(resourceUrl, MOODLE_URL);
    if (u.pathname.includes('/mod/') && u.searchParams.has('id')) {
      return Number(u.searchParams.get('id')) || null;
    }
    return null;
  } catch {
    return null;
  }
}

function unixToDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchModuleTimestamps(page, courseUrl, resourceLinks) {
  const modIds = [];
  for (const url of resourceLinks) {
    const id = extractModId(url);
    if (id) modIds.push(id);
  }
  dbg(`fetchModuleTimestamps: ${modIds.length} modIds from ${resourceLinks.length} links`);
  dbg(`  links: ${resourceLinks.slice(0,8).join(' | ')}`);
  if (modIds.length === 0) return new Map();

  const courseIdMatch = courseUrl.match(/[?&]id=(\d+)/);
  if (!courseIdMatch) return new Map();
  const courseId = Number(courseIdMatch[1]);
  dbg(`fetchModuleTimestamps: courseId=${courseId}`);

  try {
    const result = await page.evaluate(async ({ courseId, modIds }) => {
      const sesskey = window.M && window.M.cfg && window.M.cfg.sesskey;
      if (!sesskey) return null;

      const tocheck = modIds.map(id => ({ contextlevel: 'module', id, since: 0 }));
      const body = JSON.stringify([{
        index: 0,
        methodname: 'core_course_check_updates',
        args: { courseid: courseId, tocheck }
      }]);

      const resp = await fetch(`/lib/ajax/service.php?sesskey=${sesskey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      const data = await resp.json();
      if (!data || !data[0] || !data[0].data) return null;
      return data[0].data.instances || null;
    }, { courseId, modIds });

    dbg(`fetchModuleTimestamps: API result=${result ? result.length + ' instances' : 'null'}`);
    if (!result) return new Map();

    const map = new Map();
    for (const inst of result) {
      if (!inst.id || !inst.updates) continue;
      for (const upd of inst.updates) {
        if (upd.timeupdated) {
          if (!map.has(inst.id) || upd.name === 'configuration') {
            map.set(inst.id, upd.timeupdated);
          }
        }
      }
    }
    dbg(`fetchModuleTimestamps: map has ${map.size} entries`);
    return map;
  } catch (e) {
    dbg(`fetchModuleTimestamps: caught error: ${e.message}`);
    return new Map();
  }
}

async function classifyAndDownload(state, candidate, courseDir, page, creds) {
  const fp = fingerprint(
    candidate.courseUrl,
    candidate.normalizedFileUrl,
    candidate.filename
  );

  const fingerprintSet = new Set(state.files.map(f => f.fingerprint));
  if (fingerprintSet.has(fp)) {
    return { status: 'unchanged', shouldDownload: false };
  }

  const uploadDate = candidate.uploadDate || null;
  const dateFolder = candidate.subDir || uploadDate || 'unknown';
  const outputSubDir = path.join(courseDir, dateFolder);
  await fsp.mkdir(outputSubDir, { recursive: true });

  // Check if a file with this name already exists on disk at the expected path
  // (e.g. from a prior sync whose state was wiped). If so, skip re-download.
  const expectedPath = path.join(outputSubDir, candidate.filename);
  let savedPath;
  let status = 'added';

  const existingEntry = state.files.find(e => e.filename === candidate.filename && e.fileUrl === candidate.normalizedFileUrl);
  if (existingEntry) {
    // Same URL but size changed → updated
    if (existingEntry.size !== candidate.size) {
      status = 'updated';
      const oldFilePath = path.join(courseDir, existingEntry.path);
      await fsp.unlink(oldFilePath).catch(() => {});
      state.files = state.files.filter(f => f.fingerprint !== existingEntry.fingerprint);
    }
  }

  if (status === 'added' && fs.existsSync(expectedPath)) {
    // File already on disk from a prior wipe-and-resync — reuse it, no download needed
    savedPath = expectedPath;
    status = 'unchanged';
  } else {
    savedPath = await downloadCandidate(page, candidate, outputSubDir, creds);
  }

  const relativePath = path.join(dateFolder, path.basename(savedPath));

  state.files.push({
    fingerprint: fp,
    filename: candidate.filename,
    resourceUrl: candidate.resourceUrl,
    fileUrl: candidate.normalizedFileUrl,
    size: candidate.size,
    uploadDate,
    path: relativePath,
    firstSeen: isoNow()
  });

  return { status, shouldDownload: status !== 'unchanged', savedPath };
}

// ── Browser auth helpers ─────────────────────────────────────────────────────

async function acceptPrivacyIfPresent(page) {
  const checkbox = page.locator('#checkboxByPrivacyPolicy');
  if (await checkbox.count()) {
    const isChecked = await checkbox.first().isChecked().catch(() => false);
    if (!isChecked) {
      await checkbox.first().click({ timeout: 3000 }).catch(() => {});
    }
  }
}

async function loginIfPrompted(page, creds) {
  const user = page.locator('#username');
  const pass = page.locator('#password');
  const submit = page.locator('#submitButton');
  const hasLogin = (await user.count()) > 0 && (await pass.count()) > 0 && (await submit.count()) > 0;
  if (!hasLogin) return;

  await acceptPrivacyIfPresent(page);
  await user.first().fill(creds.username, { timeout: 10000 });
  await pass.first().fill(creds.password, { timeout: 10000 });
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
    submit.first().click({ timeout: 10000 })
  ]);
}

async function gotoAndAuth(page, url, creds) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await loginIfPrompted(page, creds);
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

// ── Moodle helpers ───────────────────────────────────────────────────────────

function scoreCourseMatch(required, candidate) {
  const a = required.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 100;
  if (b.includes(a)) return 80;
  if (a.includes(b)) return 70;

  const aTokens = new Set(a.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean));
  const bTokens = new Set(b.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean));
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap += 1;
  return overlap * 10;
}

function matchCourses(targetCourses, moodleCourses) {
  const out = [];
  for (const target of targetCourses) {
    if (target.courseCode) {
      const codeUpper = target.courseCode.toUpperCase();
      const byCode = moodleCourses.find(
        mc => mc.name.toUpperCase().includes(codeUpper) || mc.url.toUpperCase().includes(codeUpper)
      );
      if (byCode) {
        out.push({ requestedName: target.name, courseCode: target.courseCode, ...byCode });
        continue;
      }
    }
    const candidates = [target.name, target.enName].filter(Boolean);
    let best = null;
    for (const name of candidates) {
      const ranked = moodleCourses
        .map((mc) => ({ course: mc, score: scoreCourseMatch(name, mc.name) }))
        .sort((x, y) => y.score - x.score);
      if (ranked.length && ranked[0].score >= 20) {
        if (!best || ranked[0].score > best.score) best = ranked[0];
      }
    }
    if (best) {
      out.push({ requestedName: target.name, courseCode: target.courseCode, ...best.course });
    }
  }
  return out;
}

async function listMoodleCourses(page, creds, termFilter) {
  await gotoAndAuth(page, new URL('/my/', MOODLE_URL).toString(), creds);

  const rawLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a.aalink.coursename, .course-title a, a[href*="/course/view.php"]'))
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent || '' }))
  );

  const courses = [];
  const seen = new Set();
  for (const { href, text } of rawLinks) {
    if (!href) continue;
    const url = new URL(href, MOODLE_URL).toString();
    const name = normalizeText(text);
    if (!name) continue;
    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (termFilter && !name.startsWith(termFilter)) continue;
    courses.push({ name, url });
  }
  dbg(`listMoodleCourses: found ${courses.length} courses (termFilter=${termFilter || 'none'})`);
  return courses;
}

async function listResourceLinks(page, courseUrl, creds) {
  await gotoAndAuth(page, courseUrl, creds);

  const rawLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.activityinstance a[href], li.activity a[href], a[href*="/mod/"]'))
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent || '' }))
  );

  const links = [];
  const seen = new Set();
  for (const { href, text } of rawLinks) {
    if (!href) continue;
    const url = new URL(href, MOODLE_URL).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const name = normalizeText(text);
    links.push({ url, name });
  }
  return links;
}

async function inferFileNameFromHeaders(response, fallbackUrl) {
  const cd = response.headers()['content-disposition'] || '';
  const utf = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf && utf[1]) return decodeURIComponent(utf[1]);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return plain[1];

  try {
    const u = new URL(fallbackUrl);
    const basename = path.basename(u.pathname);
    return basename || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

async function probeFileMetadata(context, fileUrl, fallbackName) {
  const normalized = normalizeFileUrl(fileUrl);
  let response;
  try {
    response = await context.request.fetch(fileUrl, {
      method: 'HEAD',
      failOnStatusCode: false,
      timeout: 20000
    });
  } catch {
    response = null;
  }

  if (!response || response.status() >= 400) {
    response = await context.request.fetch(fileUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      failOnStatusCode: false,
      timeout: 25000
    });
  }

  const finalUrl = response.url();
  const sizeHeader = response.headers()['content-length'];
  const size = Number.isFinite(Number(sizeHeader)) ? Number(sizeHeader) : -1;
  const guessed = await inferFileNameFromHeaders(response, finalUrl || fileUrl);
  const filename = safeFilename(fallbackName || guessed);
  return {
    fileUrl: finalUrl || fileUrl,
    normalizedFileUrl: normalizeFileUrl(finalUrl || normalized),
    filename,
    size
  };
}

async function collectFilesFromResource(page, context, resourceUrl, creds, options = {}) {
  await gotoAndAuth(page, resourceUrl, creds);

  const fileExtRe = options.fileExtRe || FILE_EXT_RE;
  const anchors = page.locator('a[href*="pluginfile.php"], a[href$=".pdf"], a[href$=".ppt"], a[href$=".pptx"], a[href*="forcedownload=1"]');
  const count = await anchors.count();
  const out = [];
  const seen = new Set();

  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const hrefRaw = await anchor.getAttribute('href');
    if (!hrefRaw) continue;

    const fileUrl = new URL(hrefRaw, MOODLE_URL).toString();
    const textName = normalizeText(await anchor.innerText().catch(() => ''));
    const hintName = fileExtRe.test(textName) ? textName : undefined;

    const meta = await probeFileMetadata(context, fileUrl, hintName);
    if (!fileExtRe.test(meta.filename)) continue;

    const dedupeKey = `${resourceUrl}|${meta.normalizedFileUrl}|${meta.filename}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ resourceUrl, ...meta });
  }

  return out;
}

async function collectFilesFromFolder(page, context, folderUrl, creds, subDir, options = {}, _visited = new Set()) {
  if (_visited.has(folderUrl)) return [];
  _visited.add(folderUrl);

  await gotoAndAuth(page, folderUrl, creds);

  const fileExtRe = options.fileExtRe || FILE_EXT_RE;
  const out = [];
  const seen = new Set();

  const fileLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="pluginfile.php"], a[href*="forcedownload=1"]'))
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent || '' }))
  );
  for (const { href: hrefRaw, text } of fileLinks) {
    if (!hrefRaw) continue;

    const fileUrl = new URL(hrefRaw, MOODLE_URL).toString();
    const textName = normalizeText(text);
    const hintName = fileExtRe.test(textName) ? textName : undefined;

    const meta = await probeFileMetadata(context, fileUrl, hintName);
    if (!fileExtRe.test(meta.filename)) continue;

    const dedupeKey = `${folderUrl}|${meta.normalizedFileUrl}|${meta.filename}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ resourceUrl: folderUrl, subDir, ...meta });
  }

  // Recurse into sub-folders (restrict to main content area, exclude lang switcher links)
  const currentFolderId = new URL(folderUrl).searchParams.get('id');
  const subFolderLinks = await page.evaluate((currentId) => {
    const main = document.querySelector('[role="main"]') || document.body;
    return Array.from(main.querySelectorAll('a[href*="/mod/folder/view.php"]'))
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent || '' }))
      .filter(({ href }) => {
        try {
          const u = new URL(href, location.href);
          // Skip language variants of the current folder
          if (u.searchParams.get('id') === currentId && u.searchParams.has('lang')) return false;
          // Skip forceview-only links (Jump to... navigation)
          if (u.searchParams.has('forceview') && !u.searchParams.has('id')) return false;
          return true;
        } catch { return false; }
      });
  }, currentFolderId);
  for (const { href: hrefRaw, text } of subFolderLinks) {
    if (!hrefRaw) continue;
    const subUrl = (() => {
      const u = new URL(hrefRaw, MOODLE_URL);
      u.searchParams.delete('lang');
      u.searchParams.delete('forceview');
      return u.toString();
    })();
    if (_visited.has(subUrl)) continue;
    const subName = safeFilename(normalizeText(text) || 'subfolder');
    const nestedSubDir = path.join(subDir, subName);
    const nested = await collectFilesFromFolder(page, context, subUrl, creds, nestedSubDir, options, _visited);
    out.push(...nested);
  }

  return out;
}

async function collectFilesFromAssign(page, context, assignUrl, creds, subDir, options = {}) {
  await gotoAndAuth(page, assignUrl, creds);

  const fileExtRe = options.fileExtRe || FILE_EXT_RE;
  const out = [];
  const seen = new Set();

  const anchors = page.locator('a[href*="pluginfile.php"], a[href*="forcedownload=1"]');
  const count = await anchors.count();
  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const hrefRaw = await anchor.getAttribute('href');
    if (!hrefRaw) continue;

    const fileUrl = new URL(hrefRaw, MOODLE_URL).toString();
    const textName = normalizeText(await anchor.innerText().catch(() => ''));
    const hintName = fileExtRe.test(textName) ? textName : undefined;

    const meta = await probeFileMetadata(context, fileUrl, hintName);
    if (!fileExtRe.test(meta.filename)) continue;

    const dedupeKey = `${assignUrl}|${meta.normalizedFileUrl}|${meta.filename}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({ resourceUrl: assignUrl, subDir, ...meta });
  }

  return out;
}

async function tryDownloadByUrl(page, fileUrl, outputDir) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 45000 }),
    page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  ]);

  const suggested = safeFilename(download.suggestedFilename() || path.basename(new URL(fileUrl).pathname) || 'file.bin');
  const savePath = await ensureUniquePath(path.join(outputDir, suggested));
  await download.saveAs(savePath);
  return savePath;
}

async function downloadCandidate(page, candidate, outputDir, creds) {
  try {
    return await tryDownloadByUrl(page, candidate.fileUrl, outputDir);
  } catch {
    await gotoAndAuth(page, candidate.resourceUrl, creds);
    const filePath = (() => {
      try {
        return new URL(candidate.fileUrl).pathname;
      } catch {
        return candidate.fileUrl;
      }
    })();

    const relink = page.locator(`a[href*="${filePath.replace(/"/g, '')}"]`).first();
    if ((await relink.count()) === 0) {
      throw new Error('download link not found on resource page');
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 45000 }),
      relink.click({ timeout: 10000 })
    ]);
    const suggested = safeFilename(download.suggestedFilename() || candidate.filename);
    const savePath = await ensureUniquePath(path.join(outputDir, suggested));
    await download.saveAs(savePath);
    return savePath;
  }
}

// ── Core sync logic ───────────────────────────────────────────────────────────

async function runSyncForCourse(course, page, context, creds, report, options = {}) {
  const defaultDir = path.join(WEMUST_ROOT, courseDirName(course.courseCode || '', course.requestedName || course.name));
  const courseDir = (await findExistingCourseDirByUrl(course.url)) || defaultDir;
  const state = await loadCourseState(courseDir);
  state.courseCode = course.courseCode || state.courseCode;
  state.courseName = course.requestedName || course.name;
  state.moodleUrl = course.url;

  // Migrate fingerprints: recompute without resourceUrl and without size, deduplicate
  {
    const seen = new Map(); // newFp → index in state.files
    const toKeep = [];
    for (const entry of (state.files || [])) {
      const newFp = fingerprint(course.url, entry.fileUrl || '', entry.filename);
      if (!seen.has(newFp)) {
        entry.fingerprint = newFp;
        seen.set(newFp, toKeep.length);
        toKeep.push(entry);
      }
      // duplicate: silently drop — same file already recorded from another module
    }
    state.files = toKeep;
  }

  const resourceLinks = await listResourceLinks(page, course.url, creds);
  const resourceUrls = resourceLinks.map(r => r.url);
  // Wait for Moodle JS to finish initializing before fetching timestamps
  await page.waitForFunction(() => window.M && window.M.cfg && window.M.cfg.sesskey, { timeout: 10000 }).catch(() => {});
  const modTimestamps = await fetchModuleTimestamps(page, course.url, resourceUrls);

  for (const resource of resourceLinks) {
    const { url: resourceUrl, name: resourceName } = resource;
    let candidates = [];
    try {
      candidates = await withRetry(() => {
        if (resourceUrl.includes('/mod/folder/')) {
          const folderSubDir = safeFilename(resourceName || 'folder');
          return collectFilesFromFolder(page, context, resourceUrl, creds, folderSubDir, options);
        } else if (resourceUrl.includes('/mod/assign/')) {
          const assignSubDir = safeFilename(resourceName || 'assignment');
          return collectFilesFromAssign(page, context, resourceUrl, creds, assignSubDir, options);
        } else {
          return collectFilesFromResource(page, context, resourceUrl, creds, options);
        }
      });
    } catch (scanErr) {
      report.errors.push(`scan failed for ${resourceUrl}: ${compactError(scanErr)}`);
    }

    for (const c of candidates) {
      report.scannedCandidates += 1;
      const modId = extractModId(c.resourceUrl);
      dbg(`candidate: ${c.filename} resourceUrl=${c.resourceUrl} modId=${modId} inMap=${modTimestamps.has(modId)}`);
      const uploadDate = modId && modTimestamps.has(modId)
        ? unixToDate(modTimestamps.get(modId))
        : null;
      const candidate = { ...c, courseUrl: course.url, uploadDate };

      try {
        const result = await withRetry(() => classifyAndDownload(state, candidate, courseDir, page, creds));
        report.counts[result.status] += 1;
        if (result.savedPath) {
          report.downloaded.push({
            course: course.requestedName || course.name,
            courseCode: course.courseCode || null,
            filename: path.basename(result.savedPath),
            filePath: result.savedPath,
            status: result.status
          });
        }
      } catch (err) {
        report.counts.failed += 1;
        report.errors.push(`failed for ${c.fileUrl}: ${compactError(err)}`);
      }
    }
  }

  state.lastSynced = isoNow();
  await saveCourseState(courseDir, state);
}

function makeSyncReport(scope) {
  return {
    runAt: isoNow(),
    scope,
    termCode: null,
    timetableCourses: [],
    matchedCourses: [],
    scannedCandidates: 0,
    counts: { added: 0, updated: 0, unchanged: 0, failed: 0 },
    downloaded: [],
    errors: [],
    timetableFromCache: false
  };
}

function launchBrowser() {
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
}

// ── Command: sync ─────────────────────────────────────────────────────────────
//
// sync                       → sync current week's timetable-linked courses
// sync --week [YYYY-MM-DD]   → sync all courses for that week (default: this week)
// sync --all                 → sync every Moodle course in the current term

async function cmdSync(options) {
  await fsp.mkdir(WEMUST_ROOT, { recursive: true });
  const creds = ensureCredentials();

  // --all: every Moodle course in current term
  if ('all' in options) {
    const report = makeSyncReport('all');
    let browser, context, page;
    try {
      browser = await launchBrowser();
      context = await browser.newContext({ acceptDownloads: true });
      page = await context.newPage();

      // Determine current term: timetable cache → infer from course names
      let termFilter = null;
      try {
        const tt = JSON.parse(await fsp.readFile(TIMETABLE_PATH, 'utf8'));
        if (tt.termCode) termFilter = String(tt.termCode) + '-';
      } catch { /* no cache */ }

      if (!termFilter) {
        const allCourses = await listMoodleCourses(page, creds, null);
        const termCodes = allCourses
          .map(c => c.name.match(/^(\d{4})-/))
          .filter(Boolean)
          .map(m => m[1]);
        if (termCodes.length) {
          termFilter = termCodes.sort().at(-1) + '-';
          dbg(`auto-detected termCode=${termFilter}`);
        }
        const filtered = termFilter
          ? allCourses.filter(c => c.name.startsWith(termFilter))
          : allCourses;
        report.matchedCourses = filtered;
        for (const course of filtered) {
          await runSyncForCourse(course, page, context, creds, report);
        }
        return report;
      }

      const moodleCourses = await listMoodleCourses(page, creds, termFilter);
      report.matchedCourses = moodleCourses;
      for (const course of moodleCourses) {
        await runSyncForCourse(course, page, context, creds, report);
      }
      return report;
    } catch (err) {
      report.errors.push(compactError(err));
      throw Object.assign(err, { partialReport: report });
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  // default or --week [date]: current/specified week
  const anchor = (typeof options.week === 'string') ? options.week : macauDateOffset(0);
  validateDate(anchor);
  return syncForWeek(anchor, creds);
}

async function syncForWeek(anchorDate, creds) {
  const { mondayStr, sundayStr } = weekBounds(anchorDate);
  const label = weekKey(mondayStr, sundayStr);
  const report = makeSyncReport(`week:${label}`);
  report.forWeek = label;

  const ttState = await loadTimetableState();
  report.timetableFromCache = !isWeekStale(ttState.weeks[label], mondayStr, sundayStr);

  let browser, context, page;
  try {
    browser = await launchBrowser();
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();

    const lessons = await ensureWeekCached(ttState, mondayStr, sundayStr, page, creds);
    await saveTimetableState(ttState);
    report.termCode = ttState.termCode;

    const seen = new Set();
    const timetableCourses = [];
    for (const l of lessons) {
      if (!seen.has(l.courseCode)) {
        seen.add(l.courseCode);
        timetableCourses.push({ name: l.courseName || l.courseEnName || l.courseCode, courseCode: l.courseCode, enName: l.courseEnName || '', lessonDate: l.lessonDate });
      }
    }
    report.timetableCourses = timetableCourses.map(c => `${c.lessonDate} ${c.name}`);

    const moodleCourses = await listMoodleCourses(page, creds);
    const matched = matchCourses(timetableCourses, moodleCourses);
    report.matchedCourses = matched;

    for (const course of matched) {
      await runSyncForCourse(course, page, context, creds, report);
    }
    return report;
  } catch (err) {
    report.errors.push(compactError(err));
    throw Object.assign(err, { partialReport: report });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Command: schedule ─────────────────────────────────────────────────────────
//
// schedule                   → today's classes (Asia/Macau)
// schedule --date YYYY-MM-DD → that day's classes
// schedule --week [YYYY-MM-DD] → full week view (default: this week)
//
// Returns: { termCode, fromCache, range, lessons[] }
// Each lesson has all fields from the timetable API (courseCode, courseName,
// courseEnName, lessonDate, plus any extra fields the API provides).

async function cmdSchedule(options) {
  await fsp.mkdir(WEMUST_ROOT, { recursive: true });

  let startDate, endDate;
  if ('week' in options) {
    const anchor = (typeof options.week === 'string') ? options.week : macauDateOffset(0);
    validateDate(anchor);
    const { mondayStr, sundayStr } = weekBounds(anchor);
    startDate = mondayStr;
    endDate = sundayStr;
  } else {
    const d = options.date ? String(options.date) : macauDateOffset(0);
    if (options.date) validateDate(d);
    startDate = d;
    endDate = d;
  }

  const ttState = await loadTimetableState();
  const needsFetch = !isSemesterCovered(ttState, startDate, endDate);

  if (needsFetch) {
    const creds = ensureCredentials();
    let browser, context, page;
    try {
      browser = await launchBrowser();
      context = await browser.newContext();
      page = await context.newPage();
      await fetchRangeAndCache(page, creds, ttState, startDate, endDate);
      await saveTimetableState(ttState);
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  const lessons = [];
  for (const entry of Object.values(ttState.weeks)) {
    for (const l of (entry.lessons || [])) {
      if (l.lessonDate >= startDate && l.lessonDate <= endDate) {
        lessons.push(l);
      }
    }
  }
  lessons.sort((a, b) =>
    a.lessonDate.localeCompare(b.lessonDate) ||
    (a.courseCode || '').localeCompare(b.courseCode || '')
  );

  return {
    termCode: ttState.termCode,
    fromCache: !needsFetch,
    range: startDate === endDate ? startDate : `${startDate} → ${endDate}`,
    lessons
  };
}

// ── Command: pending ─────────────────────────────────────────────────────────
//
// pending                        → all upcoming Moodle events (assignments, quizzes, etc.)
// pending --course COURSECODE    → filtered by course code
//
// Returns: { total, events[] }
// Each event: { name, dueDate, course, courseUrl, eventType, url }

async function cmdPending(options) {
  const creds = ensureCredentials();
  let browser, context, page;
  try {
    browser = await launchBrowser();
    context = await browser.newContext();
    page = await context.newPage();

    const calUrl = new URL('calendar/view.php?view=upcoming', MOODLE_URL).toString();
    await gotoAndAuth(page, calUrl, creds);

    await Promise.race([
      page.waitForSelector('[data-type="event"]', { timeout: 15000 }),
      page.waitForSelector('.emptymessage', { timeout: 15000 })
    ]).catch(() => {});

    const events = await page.evaluate(() => {
      const result = [];
      for (const el of document.querySelectorAll('[data-type="event"]')) {
        const name = el.querySelector('h3.name')?.textContent?.trim()
          || el.getAttribute('data-event-title') || '';
        if (!name) continue;

        let dueDate = '', course = '', courseUrl = '',
          eventType = el.getAttribute('data-event-eventtype') || '', url = '';

        for (const row of el.querySelectorAll('.row, .row.mt-1')) {
          const icon = row.querySelector('i[title]');
          if (!icon) continue;
          const title = icon.getAttribute('title');
          const col = row.querySelector('.col-11');
          if (!col) continue;
          if (title === 'When') dueDate = col.textContent.trim();
          else if (title === 'Event type') eventType = col.textContent.trim();
          else if (title === 'Course') {
            const a = col.querySelector('a');
            course = a ? a.textContent.trim() : col.textContent.trim();
            courseUrl = a ? a.href : '';
          }
        }

        const footerLink = el.querySelector('.card-footer a, a.card-link');
        url = footerLink ? footerLink.href : '';

        result.push({ name, dueDate, course, courseUrl, eventType, url });
      }
      return result;
    });

    const courseFilter = options.course ? String(options.course).toUpperCase() : null;
    const filtered = courseFilter
      ? events.filter(e =>
          e.course.toUpperCase().includes(courseFilter) ||
          e.courseUrl.toUpperCase().includes(courseFilter))
      : events;

    return { total: filtered.length, events: filtered };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Command: files ────────────────────────────────────────────────────────────
//
// files                              → all downloaded files across all courses
// files --course COURSECODE          → all files for that course
// files --course COURSECODE --date YYYY-MM-DD
//                                    → files uploaded between the previous class
//                                      and targetDate for that course
// files --recent [--n N]             → N most recently synced files (default 10)
//
// Returns: array of { courseCode, courseName, filename, uploadDate, path, ... }

async function cmdFiles(options) {
  let entries = [];
  try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { }

  const courseFilter = options.course ? String(options.course).toUpperCase() : null;
  const targetDate = options.date ? String(options.date) : null;
  if (targetDate) validateDate(targetDate);

  // --recent: most recently synced files across all courses
  if ('recent' in options) {
    const n = options.n ? Number(options.n) : 10;
    const all = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
      if (!state.files) continue;
      for (const f of state.files) {
        all.push({
          courseCode: state.courseCode,
          courseName: state.courseName,
          filename: f.filename,
          uploadDate: f.uploadDate,
          firstSeen: f.firstSeen,
          path: path.join(WEMUST_ROOT, entry.name, f.path)
        });
      }
    }
    all.sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));
    return all.slice(0, n);
  }

  // --course --date: files for a specific class session
  // Returns files uploaded after the previous class and on/before targetDate
  if (courseFilter && targetDate) {
    let state = null;
    let dirName = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const s = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
      if (s.courseCode && s.courseCode.toUpperCase() === courseFilter) {
        state = s;
        dirName = entry.name;
        break;
      }
    }
    if (!state) return { fromCache: false, prevDate: null, files: [] };

    const creds = ensureCredentials();
    const LOOKBACK_DAYS = [28, 56, 84];
    const target = new Date(targetDate + 'T12:00:00+08:00');
    const ttState = await loadTimetableState();
    let prevDate = null;
    let fromCache = true;
    let rightEdge = targetDate;

    let browser, context, page;
    try {
      for (const days of LOOKBACK_DAYS) {
        const ws = new Date(target);
        ws.setDate(target.getDate() - days);
        const windowStartStr = ws.toISOString().slice(0, 10);

        if (!isSemesterCovered(ttState, windowStartStr, rightEdge)) {
          fromCache = false;
          if (!browser) {
            browser = await launchBrowser();
            context = await browser.newContext();
            page = await context.newPage();
          }
          try {
            await fetchRangeAndCache(page, creds, ttState, windowStartStr, rightEdge);
            await saveTimetableState(ttState);
          } catch { /* use whatever is cached */ }
        }

        rightEdge = windowStartStr;
        const dates = getLessonDatesForCourse(ttState, state.courseCode)
          .filter(d => d >= windowStartStr && d < targetDate);
        if (dates.length > 0) {
          prevDate = dates[dates.length - 1];
          break;
        }
      }
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }

    const files = (state.files || [])
      .filter(f => {
        if (!f.uploadDate) return false;
        if (f.uploadDate > targetDate) return false;
        if (prevDate && f.uploadDate <= prevDate) return false;
        return true;
      })
      .map(f => ({
        filename: f.filename,
        uploadDate: f.uploadDate,
        path: path.join(WEMUST_ROOT, dirName, f.path)
      }));

    return { fromCache, prevDate, files };
  }

  // --course only or no filter: list all matching files
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
    if (!state.files) continue;
    if (courseFilter && (!state.courseCode ||
        !state.courseCode.toUpperCase().includes(courseFilter))) continue;
    for (const f of state.files) {
      result.push({
        courseCode: state.courseCode,
        courseName: state.courseName,
        moodleUrl: state.moodleUrl,
        filename: f.filename,
        uploadDate: f.uploadDate,
        path: path.join(WEMUST_ROOT, entry.name, f.path)
      });
    }
  }
  result.sort((a, b) => (a.uploadDate || '').localeCompare(b.uploadDate || ''));
  return result;
}

// ── Command: courses ──────────────────────────────────────────────────────────
//
// courses → list every enrolled course in this term (from local cache).
//           If the cache is empty, auto-runs `sync --all` first.
//
// Returns: { source: 'cache'|'fresh-sync', termCode, total, courses[] }
// Each course: { courseCode, courseName, moodleUrl, files, lastSynced }

async function cmdCourses() {
  let entries = [];
  try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { }

  let source = 'cache';
  let hasAny = entries.some(e => e.isDirectory());
  if (!hasAny) {
    source = 'fresh-sync';
    await cmdSync({ all: true });
    try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { }
  }

  const ttState = await loadTimetableState();
  const courses = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
    if (!state.moodleUrl) continue;
    courses.push({
      courseCode: state.courseCode || null,
      courseName: state.courseName || null,
      moodleUrl: state.moodleUrl,
      files: state.files ? state.files.length : 0,
      lastSynced: state.lastSynced || null
    });
  }
  courses.sort((a, b) => (a.courseCode || '').localeCompare(b.courseCode || ''));

  return { source, termCode: ttState.termCode, total: courses.length, courses };
}

// ── Command: course ───────────────────────────────────────────────────────────
//
// course --code COURSECODE → fresh-fetch one course's assignments, quizzes,
//                            and recent materials from Moodle.
//
// Returns: { courseCode, courseName, moodleUrl, assignments[], quizzes[], materials[] }

async function cmdCourse(options) {
  if (!options.code) throw new Error('course requires --code COURSECODE');
  const codeUpper = String(options.code).toUpperCase();

  // Resolve course URL from cache; fall back to a live Moodle dashboard scan
  let entries = [];
  try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { }
  let target = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
    if (state.courseCode && state.courseCode.toUpperCase() === codeUpper) {
      target = { courseCode: state.courseCode, courseName: state.courseName, url: state.moodleUrl };
      break;
    }
  }

  const creds = ensureCredentials();
  let browser, context, page;
  try {
    browser = await launchBrowser();
    context = await browser.newContext();
    page = await context.newPage();

    if (!target) {
      const moodleCourses = await listMoodleCourses(page, creds);
      const hit = moodleCourses.find(
        c => c.name.toUpperCase().includes(codeUpper) || c.url.toUpperCase().includes(codeUpper)
      );
      if (!hit) throw new Error(`Course '${options.code}' not found. Run 'sync --all' or check the code.`);
      target = { courseCode: codeUpper, courseName: hit.name, url: hit.url };
    }

    const resourceLinks = await listResourceLinks(page, target.url, creds);
    await page.waitForFunction(
      () => window.M && window.M.cfg && window.M.cfg.sesskey,
      { timeout: 10000 }
    ).catch(() => {});
    const modTimestamps = await fetchModuleTimestamps(page, target.url, resourceLinks.map(r => r.url));

    const enrich = link => {
      const modId = extractModId(link.url);
      const ts = modId && modTimestamps.get(modId);
      return { name: link.name, url: link.url, updated: ts ? unixToDate(ts) : null };
    };

    const assignments = resourceLinks.filter(r => r.url.includes('/mod/assign/')).map(enrich);
    const quizzes    = resourceLinks.filter(r => r.url.includes('/mod/quiz/')).map(enrich);
    const materials  = resourceLinks
      .filter(r => r.url.includes('/mod/resource/') || r.url.includes('/mod/folder/'))
      .map(enrich)
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

    return {
      courseCode: target.courseCode,
      courseName: target.courseName,
      moodleUrl: target.url,
      assignments,
      quizzes,
      materials
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Command: status ───────────────────────────────────────────────────────────
//
// status → overview of sync state
//
// Returns: { totalCourses, totalFiles, lastSynced, timetable, courses[], wemustRoot }

async function cmdStatus() {
  let entries = [];
  try { entries = await fsp.readdir(WEMUST_ROOT, { withFileTypes: true }); } catch { }

  const courseList = [];
  let totalFiles = 0;
  let lastSynced = null;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await loadCourseState(path.join(WEMUST_ROOT, entry.name));
    if (!state.lastSynced && (!state.files || state.files.length === 0)) continue;
    const fileCount = state.files ? state.files.length : 0;
    totalFiles += fileCount;
    if (state.lastSynced && (!lastSynced || state.lastSynced > lastSynced)) {
      lastSynced = state.lastSynced;
    }
    courseList.push({
      courseCode: state.courseCode,
      courseName: state.courseName,
      moodleUrl: state.moodleUrl,
      files: fileCount,
      lastSynced: state.lastSynced
    });
  }

  const ttState = await loadTimetableState();
  const weekKeys = Object.keys(ttState.weeks).sort();
  const timetable = weekKeys.length > 0 ? {
    termCode: ttState.termCode,
    weeksCached: weekKeys.length,
    earliest: weekKeys[0],
    latest: weekKeys[weekKeys.length - 1]
  } : null;

  return {
    totalCourses: courseList.length,
    totalFiles,
    lastSynced,
    timetable,
    courses: courseList,
    wemustRoot: WEMUST_ROOT
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const [cmd, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    options[key] = value;
  }
  return { cmd, options };
}

function printUsage() {
  console.log(`Usage:
  node scripts/muster_cli.js sync [--week [YYYY-MM-DD]] [--all]
  node scripts/muster_cli.js schedule [--date YYYY-MM-DD] [--week [YYYY-MM-DD]]
  node scripts/muster_cli.js courses
  node scripts/muster_cli.js course --code COURSECODE
  node scripts/muster_cli.js pending [--course COURSECODE]
  node scripts/muster_cli.js files [--course COURSECODE] [--date YYYY-MM-DD] [--recent [--n N]]
  node scripts/muster_cli.js status

Examples:
  sync                          sync current week's timetable-linked courses
  sync --week                   sync this full week
  sync --week 2026-03-13        sync the week containing that date
  sync --all                    sync every course in the current term (first-time setup)
  schedule                      show today's classes
  schedule --week               show this week's timetable
  courses                       list every enrolled course (auto-syncs on first run)
  course --code CS101           show CS101 assignments / quizzes / recent materials (live)
  pending                       show all upcoming Moodle assignments/events
  files --course CS101          show all downloaded files for CS101
  files --course CS101 --date 2026-03-13   show files between the previous class and that date
  files --recent --n 20         show 20 most recently synced files
  status                        show sync state overview

Notes:
  - mod/folder resources are downloaded recursively, preserving folder structure
  - mod/assign resources create a named subfolder and download intro attachments
  - Only PDF/PPT/PPTX are downloaded`);
}

async function main() {
  const { cmd, options } = parseCli(process.argv.slice(2));
  if (options.debug) DEBUG = true;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  let result;
  if (cmd === 'sync')          result = await cmdSync(options);
  else if (cmd === 'schedule') result = await cmdSchedule(options);
  else if (cmd === 'pending')  result = await cmdPending(options);
  else if (cmd === 'files')    result = await cmdFiles(options);
  else if (cmd === 'courses')  result = await cmdCourses(options);
  else if (cmd === 'course')   result = await cmdCourse(options);
  else if (cmd === 'status')   result = await cmdStatus();
  else throw new Error(`Unknown command '${cmd}'. Run with --help for usage.`);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const out = err.partialReport
    ? { error: String(err.message || err), partialReport: err.partialReport }
    : { error: String(err.message || err) };
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
});

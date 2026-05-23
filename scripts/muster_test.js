#!/usr/bin/env node
'use strict';

/**
 * Unit tests for pure utility functions in muster_cli.js
 * No browser / network required.
 *
 * Run:  node scripts/muster_test.js
 */

// ── Minimal re-implementations for testing ────────────────────────────────────
// We copy-test the exact source code rather than require() the module to avoid
// triggering the CLI entry-point and its side-effects.

const crypto = require('crypto');

const TZ = 'Asia/Macau';
const MOODLE_URL = 'https://moodle.must.edu.mo/';
const STALE_CURRENT_MS = 6 * 3600 * 1000;
const STALE_FUTURE_MS  = 24 * 3600 * 1000;
const TRANSIENT_QUERY_PARAMS = new Set([
  'token', 'forcedownload', 'download', 'time', 'expires', 'signature',
  'sesskey', 'redirect', 'cache', 't', '_'
]);

function macauDateOffset(days) {
  const base = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(base);
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
}

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date '${date}'.`);
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
      if (!TRANSIENT_QUERY_PARAMS.has(key.toLowerCase())) kept.append(key, value);
    }
    const sorted = [...kept.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sorted.length > 0 && !resolved.pathname.includes('pluginfile.php')) {
      out.search = new URLSearchParams(sorted).toString();
    }
    return out.toString();
  } catch { return rawUrl; }
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
  return text.split('\n')[0].slice(0, 400);
}

function courseDirName(courseCode, courseName) {
  const raw = courseCode ? `${courseCode}-${courseName}` : courseName;
  return safeFilename(raw);
}

function weekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00+08:00');
  const dow = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = x => x.toISOString().slice(0, 10);
  return { mondayStr: fmt(monday), sundayStr: fmt(sunday) };
}

function weekKey(mondayStr, sundayStr) { return `${mondayStr}_${sundayStr}`; }

function isWeekStale(entry, mondayStr, sundayStr) {
  if (!entry || !entry.fetchedAt) return true;
  const todayStr = macauDateOffset(0);
  if (sundayStr < todayStr) return false;
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  if (mondayStr <= todayStr) return ageMs > STALE_CURRENT_MS;
  return ageMs > STALE_FUTURE_MS;
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

function extractModId(resourceUrl) {
  try {
    const u = new URL(resourceUrl, MOODLE_URL);
    if (u.pathname.includes('/mod/') && u.searchParams.has('id')) {
      return Number(u.searchParams.get('id')) || null;
    }
    return null;
  } catch { return null; }
}

function unixToDate(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
      if (byCode) { out.push({ requestedName: target.name, courseCode: target.courseCode, ...byCode }); continue; }
    }
    const candidates = [target.name, target.enName].filter(Boolean);
    let best = null;
    for (const name of candidates) {
      const ranked = moodleCourses
        .map(mc => ({ course: mc, score: scoreCourseMatch(name, mc.name) }))
        .sort((x, y) => y.score - x.score);
      if (ranked.length && ranked[0].score >= 20) {
        if (!best || ranked[0].score > best.score) best = ranked[0];
      }
    }
    if (best) out.push({ requestedName: target.name, courseCode: target.courseCode, ...best.course });
  }
  return out;
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nmacauDateOffset');
test('offset=0 returns today in YYYY-MM-DD', () => {
  const d = macauDateOffset(0);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d), `bad format: ${d}`);
});
test('offset=1 is tomorrow', () => {
  const today = macauDateOffset(0);
  const tomorrow = macauDateOffset(1);
  assert(tomorrow > today, `${tomorrow} should be after ${today}`);
});
test('offset=-1 is yesterday', () => {
  const today = macauDateOffset(0);
  const yesterday = macauDateOffset(-1);
  assert(yesterday < today, `${yesterday} should be before ${today}`);
});

console.log('\nvalidateDate');
test('valid date passes', () => { validateDate('2026-03-19'); });
test('invalid format throws', () => {
  let threw = false;
  try { validateDate('26-3-19'); } catch { threw = true; }
  assert(threw);
});
test('non-date string throws', () => {
  let threw = false;
  try { validateDate('not-a-date'); } catch { threw = true; }
  assert(threw);
});

console.log('\nnormalizeText');
test('collapses whitespace', () => {
  assertEqual(normalizeText('  hello   world  '), 'hello world');
});
test('handles null/undefined', () => {
  assertEqual(normalizeText(null), '');
  assertEqual(normalizeText(undefined), '');
});
test('trims tabs and newlines', () => {
  assertEqual(normalizeText('\t foo\n bar\t'), 'foo bar');
});

console.log('\nnormalizeFileUrl');
test('strips forcedownload param', () => {
  const raw = 'https://moodle.must.edu.mo/mod/resource/view.php?id=123&forcedownload=1';
  const result = normalizeFileUrl(raw);
  assert(!result.includes('forcedownload'), result);
  assert(result.includes('id=123'), result);
});
test('strips token param', () => {
  const raw = 'https://moodle.must.edu.mo/mod/resource/view.php?id=5&token=abc123';
  const result = normalizeFileUrl(raw);
  assert(!result.includes('token'), result);
});
test('keeps non-transient params', () => {
  const raw = 'https://moodle.must.edu.mo/mod/resource/view.php?id=99&revision=3';
  const result = normalizeFileUrl(raw);
  assert(result.includes('revision=3'), result);
});
test('pluginfile.php strips all params', () => {
  const raw = 'https://moodle.must.edu.mo/pluginfile.php/123/mod_resource/content/0/file.pdf?revision=2&forcedownload=1';
  const result = normalizeFileUrl(raw);
  assert(!result.includes('?'), `unexpected query: ${result}`);
});
test('relative url resolved against MOODLE_URL', () => {
  const raw = '/mod/resource/view.php?id=42';
  const result = normalizeFileUrl(raw);
  assert(result.startsWith('https://moodle.must.edu.mo'), result);
});
test('non-url string resolved relative to MOODLE_URL (no crash)', () => {
  // new URL(str, base) never throws for arbitrary strings — they get resolved
  const raw = 'some/relative/path?token=x&id=5';
  const result = normalizeFileUrl(raw);
  assert(result.startsWith('https://moodle.must.edu.mo'), result);
  assert(!result.includes('token='), result); // transient param stripped
});

console.log('\nfingerprint');
test('same inputs produce same hash', () => {
  const a = fingerprint('http://a', 'http://b', 'file.pdf');
  const b = fingerprint('http://a', 'http://b', 'file.pdf');
  assertEqual(a, b);
});
test('different filename produces different hash', () => {
  const a = fingerprint('http://a', 'http://b', 'file.pdf');
  const b = fingerprint('http://a', 'http://b', 'other.pdf');
  assert(a !== b);
});
test('hash is 64-char hex', () => {
  const h = fingerprint('a', 'b', 'c');
  assert(/^[0-9a-f]{64}$/.test(h), h);
});

console.log('\nsafeFilename');
test('strips forbidden characters', () => {
  const result = safeFilename('foo/bar:baz*qux?.txt');
  assert(!result.match(/[\\/:*?"<>|]/), result);
});
test('truncates to 240 chars', () => {
  const long = 'a'.repeat(300) + '.pdf';
  assert(safeFilename(long).length <= 240);
});
test('safe name unchanged', () => {
  assertEqual(safeFilename('lecture_01.pdf'), 'lecture_01.pdf');
});

console.log('\ncompactError');
test('takes first line of multiline error', () => {
  const err = new Error('line one\nline two\nline three');
  assertEqual(compactError(err), 'line one');
});
test('truncates at 400 chars', () => {
  const err = new Error('x'.repeat(500));
  assert(compactError(err).length <= 400);
});
test('handles string error', () => {
  assertEqual(compactError('oops'), 'oops');
});

console.log('\ncourseDirName');
test('with courseCode: code-name', () => {
  assertEqual(courseDirName('CS360', 'Networks'), 'CS360-Networks');
});
test('without courseCode: name only', () => {
  assertEqual(courseDirName('', 'Networks'), 'Networks');
  assertEqual(courseDirName(null, 'Networks'), 'Networks');
});
test('sanitizes forbidden chars', () => {
  const result = courseDirName('CS/360', 'Net:works');
  assert(!result.match(/[\\/:*?"<>|]/), result);
});

console.log('\nweekBounds');
test('Monday returns itself as mondayStr', () => {
  const { mondayStr } = weekBounds('2026-03-16'); // Monday
  assertEqual(mondayStr, '2026-03-16');
});
test('Sunday returns itself as sundayStr', () => {
  const { sundayStr } = weekBounds('2026-03-22'); // Sunday
  assertEqual(sundayStr, '2026-03-22');
});
test('Wednesday in week → correct Monday/Sunday', () => {
  const { mondayStr, sundayStr } = weekBounds('2026-03-18'); // Wednesday
  assertEqual(mondayStr, '2026-03-16');
  assertEqual(sundayStr, '2026-03-22');
});
test('saturday → correct week bounds', () => {
  const { mondayStr, sundayStr } = weekBounds('2026-03-21'); // Saturday
  assertEqual(mondayStr, '2026-03-16');
  assertEqual(sundayStr, '2026-03-22');
});

console.log('\nweekKey');
test('formats as mon_sun', () => {
  assertEqual(weekKey('2026-03-16', '2026-03-22'), '2026-03-16_2026-03-22');
});

console.log('\nisWeekStale');
test('null entry is stale', () => {
  assert(isWeekStale(null, '2026-03-16', '2026-03-22'));
});
test('missing fetchedAt is stale', () => {
  assert(isWeekStale({}, '2026-03-16', '2026-03-22'));
});
test('past week is never stale', () => {
  const past = { fetchedAt: new Date(Date.now() - 999 * 86400000).toISOString() };
  assert(!isWeekStale(past, '2020-01-06', '2020-01-12'));
});
test('current week fresh entry not stale', () => {
  const { mondayStr, sundayStr } = weekBounds(macauDateOffset(0));
  const fresh = { fetchedAt: new Date().toISOString() };
  assert(!isWeekStale(fresh, mondayStr, sundayStr));
});
test('current week old entry is stale', () => {
  const { mondayStr, sundayStr } = weekBounds(macauDateOffset(0));
  const old = { fetchedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString() };
  assert(isWeekStale(old, mondayStr, sundayStr));
});

console.log('\ngetLessonDatesForCourse');
test('returns sorted dates for matching courseCode', () => {
  const ttState = {
    weeks: {
      'w1': { lessons: [
        { courseCode: 'CS360', lessonDate: '2026-03-19' },
        { courseCode: 'CS370', lessonDate: '2026-03-20' },
      ]},
      'w2': { lessons: [
        { courseCode: 'CS360', lessonDate: '2026-03-12' },
      ]},
    }
  };
  const dates = getLessonDatesForCourse(ttState, 'CS360');
  assert(JSON.stringify(dates) === JSON.stringify(['2026-03-12', '2026-03-19']), JSON.stringify(dates));
});
test('returns empty for unknown course', () => {
  const ttState = { weeks: { 'w1': { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] } } };
  assertEqual(getLessonDatesForCourse(ttState, 'CS999').length, 0);
});
test('deduplicates dates', () => {
  const ttState = {
    weeks: {
      'w1': { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] },
      'w2': { lessons: [{ courseCode: 'CS360', lessonDate: '2026-03-19' }] },
    }
  };
  assertEqual(getLessonDatesForCourse(ttState, 'CS360').length, 1);
});

console.log('\nextractModId');
test('extracts id from resource url', () => {
  assertEqual(extractModId('https://moodle.must.edu.mo/mod/resource/view.php?id=12345'), 12345);
});
test('extracts id from relative url', () => {
  assertEqual(extractModId('/mod/quiz/view.php?id=999'), 999);
});
test('returns null for non-mod url', () => {
  assert(extractModId('https://moodle.must.edu.mo/course/view.php?id=1') === null);
});
test('returns null for invalid url', () => {
  assert(extractModId('not a url') === null);
});

console.log('\nunixToDate');
test('converts epoch 0 to 1970-01-01', () => {
  assertEqual(unixToDate(0), '1970-01-01');
});
test('known timestamp', () => {
  // 2026-03-19 00:00:00 UTC: days since epoch = 31+28+18+77=... verify with Date
  const ts = Math.floor(new Date('2026-03-19T00:00:00Z').getTime() / 1000);
  assertEqual(unixToDate(ts), '2026-03-19');
});
test('pads month and day', () => {
  const d = unixToDate(86400); // 1970-01-02
  assertEqual(d, '1970-01-02');
});

console.log('\nscoreCourseMatch');
test('exact match → 100', () => {
  assertEqual(scoreCourseMatch('cs360', 'cs360'), 100);
});
test('candidate contains required → 80', () => {
  assertEqual(scoreCourseMatch('cs360', '2602-cs360d2'), 80);
});
test('required contains candidate → 70', () => {
  assertEqual(scoreCourseMatch('2602-cs360d2', 'cs360'), 70);
});
test('no match → 0', () => {
  assertEqual(scoreCourseMatch('math101', 'cs999'), 0);
});
test('token overlap scoring', () => {
  const score = scoreCourseMatch('computer networks', 'networks and protocols');
  assert(score >= 10, `expected >= 10, got ${score}`);
});

console.log('\nmatchCourses');
test('matches by courseCode', () => {
  const targets = [{ name: 'Networks', courseCode: 'CS360', enName: '' }];
  const moodle = [
    { name: '2602-CS360D2-XXXXXX', url: 'https://moodle.must.edu.mo/course/view.php?id=1' },
    { name: '2602-CS370D1-YYYYYY', url: 'https://moodle.must.edu.mo/course/view.php?id=2' },
  ];
  const result = matchCourses(targets, moodle);
  assertEqual(result.length, 1);
  assertEqual(result[0].courseCode, 'CS360');
  assert(result[0].name.includes('CS360'), result[0].name);
});
test('matches by name token when no courseCode', () => {
  const targets = [{ name: 'Numerical Methods', courseCode: '', enName: '' }];
  const moodle = [
    { name: '2602-Numerical Methods-XXXXXX', url: 'https://moodle.must.edu.mo/course/view.php?id=3' },
  ];
  const result = matchCourses(targets, moodle);
  assertEqual(result.length, 1);
});
test('returns empty if no match above threshold', () => {
  const targets = [{ name: 'Astrophysics 999', courseCode: '', enName: '' }];
  const moodle = [{ name: '2602-CS360D2', url: 'u' }];
  const result = matchCourses(targets, moodle);
  assertEqual(result.length, 0);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

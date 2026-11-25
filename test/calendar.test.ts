// Deadlines in business days: how the days are counted, and that the
// calendar they are counted on cannot be changed under a deadline.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseCalendar } from '../src/calendar.js';
import * as core from '../src/core.js';
import { formatRule, parseRule, RuleError } from '../src/rulefile.js';
import { TsutomeError } from '../src/tsutome.js';
import { calendar, DELETE_AFTER_ANSWER, HANDLE_INQUIRY, workspace } from './helpers.js';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');
const ROOT = join(import.meta.dirname, '..', '..');

/** A workspace with the calendar and the rule in force, in that order. */
async function inForce(cal = calendar()) {
  const w = await workspace('2026-11-02T00:00:00Z');
  await w.t.adoptCalendar(await w.cal(cal), 'manager');
  await w.t.adopt(await w.rule('handle-inquiry.md', HANDLE_INQUIRY), 'manager');
  return w;
}
const due = async (w: Awaited<ReturnType<typeof workspace>>) => (await w.t.duties()).map((d) => [d.about.item, d.status, d.dueAt, d.counted?.lastDay]);

test('received on a Saturday night before a Sunday and a holiday Monday: three business days end with Thursday', async () => {
  const w = await inForce();
  w.at('2026-11-21T11:37:00Z'); // Saturday 20:37 in Tokyo
  await w.t.record('inquiry.received', { item: 'q' }, 'site');
  // Sunday and Monday the 23rd (a holiday) are not counted: Tuesday, Wednesday, Thursday. The deadline is the end of Thursday in Tokyo.
  assert.deepEqual(await due(w), [['q', 'due', '2026-11-26T15:00:00Z', '2026-11-26']]);
  const d = (await w.t.duties())[0] as core.Duty;
  assert.deepEqual(d.counted, { within: '3bd', calendar: 'jp', calendarVersion: 1, calendarDigest: parseCalendar(calendar()).digest, timezone: '+09:00', lastDay: '2026-11-26' });
  assert.deepEqual([d.startsAt, d.noticeAt], ['2026-11-21T11:37:00Z', '2026-11-21T11:37:00Z']);

  // Three calendar days would have ended on Tuesday night, the first day back. In business days it is still in time then.
  w.at('2026-11-24T11:38:00Z');
  assert.deepEqual((await w.t.duties()).map((x) => x.status), ['due']);
  assert.deepEqual(await w.t.audit(), [{ kind: 'not_told', seq: 2, duty: d.id, message: 'handle-inquiry: support has not been told that inquiry.answered for item q is due' }]);
  w.at('2026-11-26T15:00:00Z'); // the last instant of Thursday
  assert.equal((await w.t.duties())[0]?.status, 'due');
  w.at('2026-11-26T15:00:01Z');
  assert.equal((await w.t.duties())[0]?.status, 'overdue');
  // The finding says how the deadline was counted.
  assert.match((await w.t.audit())[0]?.message ?? '', /was due 2026-11-26T15:00:00Z \(the end of 2026-11-26 \+09:00, 3 business days by calendar jp version 1\) and has not happened/);
  await w.t.record('inquiry.answered', { item: 'q' }, 'support');
  assert.equal((await w.t.duties())[0]?.status, 'done_late');
});

test('the day of receipt is not counted, and a day is a day in the calendar\'s zone', async () => {
  const w = await inForce();
  w.at('2026-11-13T08:30:00Z'); // Friday 17:30 in Tokyo
  await w.t.record('inquiry.received', { item: 'fri-evening' });
  w.at('2026-11-15T15:10:00Z'); // Monday 00:10 in Tokyo, still Sunday in UTC
  await w.t.record('inquiry.received', { item: 'mon-first-minute' });
  w.at('2026-11-16T14:59:00Z'); // Monday 23:59 in Tokyo
  await w.t.record('inquiry.received', { item: 'mon-last-minute' });
  w.at('2026-11-16T15:00:00Z'); // Tuesday 00:00 in Tokyo
  await w.t.record('inquiry.received', { item: 'tue-midnight' });
  assert.deepEqual(await due(w), [
    ['fri-evening', 'due', '2026-11-18T15:00:00Z', '2026-11-18'], // Monday, Tuesday, Wednesday
    ['mon-first-minute', 'due', '2026-11-19T15:00:00Z', '2026-11-19'], // Tuesday, Wednesday, Thursday
    ['mon-last-minute', 'due', '2026-11-19T15:00:00Z', '2026-11-19'],
    ['tue-midnight', 'due', '2026-11-20T15:00:00Z', '2026-11-20'], // Wednesday, Thursday, Friday
  ]);
});

test('over the New Year: the office\'s own closed days are in the calendar with the holidays', async () => {
  const w = await inForce();
  w.at('2026-12-28T01:00:00Z'); // Monday 10:00 in Tokyo, the last day open
  await w.t.record('inquiry.received', { item: 'last-day' });
  w.at('2026-12-31T03:00:00Z'); // during the closure
  await w.t.record('inquiry.received', { item: 'closed' });
  // Closed Dec 29 to Jan 1, then a weekend: the count is Jan 4, 5, 6 for both.
  assert.deepEqual(await due(w), [
    ['last-day', 'due', '2027-01-06T15:00:00Z', '2027-01-06'],
    ['closed', 'due', '2027-01-06T15:00:00Z', '2027-01-06'],
  ]);
  w.at('2027-01-08T02:00:00Z'); // Friday; Monday the 11th is a holiday
  await w.t.record('inquiry.received', { item: 'new-year' });
  assert.deepEqual((await due(w))[2], ['new-year', 'due', '2027-01-14T15:00:00Z', '2027-01-14']);
});

test('a calendar adopted later does not move a deadline counted before it', async () => {
  const w = await workspace('2026-11-02T00:00:00Z');
  const rule = await w.rule('handle-inquiry.md', HANDLE_INQUIRY);
  // The rule cannot be put in force before its calendar.
  await assert.rejects(w.t.adopt(rule, 'manager'), (e: Error) => e instanceof TsutomeError && /calendar jp, which has not been adopted; a person adopts it first/.test(e.message));
  const file = await w.cal(calendar());
  assert.deepEqual((await w.t.calendars()).map((c) => [c.id, c.state]), [['jp', 'draft']]);
  await assert.rejects(w.t.adoptCalendar(file, ''), /names who adopts/);
  const v1 = await w.t.adoptCalendar(file, 'manager');
  assert.deepEqual([v1.version, v1.adoptedBy, v1.timezone, v1.weekend, v1.from, v1.until, v1.closed.length], [1, 'manager', '+09:00', ['sat', 'sun'], '2026-01-01', '2027-12-31', 7]);
  await assert.rejects(w.t.adoptCalendar(file, 'manager'), /already in force/);
  await w.t.adopt(rule, 'manager');

  w.at('2026-12-11T01:00:00Z'); // Friday 10:00 in Tokyo
  await w.t.record('inquiry.received', { item: 'a' });
  assert.deepEqual(await due(w), [['a', 'due', '2026-12-16T15:00:00Z', '2026-12-16']]);

  // The office decides to close on Tuesday the 15th. The file changes; nothing else does until a person adopts it.
  await w.cal(calendar(['2026-12-15 closed for stocktaking']));
  assert.deepEqual((await w.t.calendars()).map((c) => [c.state, c.adopted?.version]), [['changed', 1]]);
  await w.t.record('inquiry.received', { item: 'b' });
  w.at('2026-12-11T02:00:00Z');
  const v2 = await w.t.adoptCalendar(file, 'manager');
  assert.equal(v2.version, 2);
  await w.t.record('inquiry.received', { item: 'c' });
  // a and b started under version 1 and keep it. c counts Monday, Wednesday, Thursday.
  assert.deepEqual((await w.t.duties()).map((d) => [d.about.item, d.counted?.calendarVersion, d.dueAt]), [
    ['a', 1, '2026-12-16T15:00:00Z'],
    ['b', 1, '2026-12-16T15:00:00Z'],
    ['c', 2, '2026-12-17T15:00:00Z'],
  ]);
  assert.deepEqual((await w.t.calendars()).map((c) => [c.state, c.adopted?.version]), [['adopted', 2]]);
  // Every day of the calendar is in the chain: nothing but the chain is needed to count.
  const adopted = (await w.t.verify()).entries.filter((e) => e.event === 'tsutome.calendar_adopted');
  assert.deepEqual(adopted.map((e) => [e.meta.calendar, e.meta.timezone, e.meta.weekend, e.meta.closed?.includes('2026-12-15')]), [['jp', '+09:00', 'sat,sun', false], ['jp', '+09:00', 'sat,sun', true]]);
  assert.equal(adopted[1]?.meta.digest, parseCalendar(calendar(['2026-12-15 closed for stocktaking'])).digest);
  assert.ok(!JSON.stringify(adopted).includes('stocktaking'));
});

test('a service that writes its own records: a rule in business days gives rise to nothing until its calendar is adopted', () => {
  const lines: string[] = [];
  const add = (event: string, meta: { [k: string]: string }, at: string): void => {
    const prev = lines.length ? { prev: 'sha256:' + core.sha256(lines[lines.length - 1] as string) } : {};
    lines.push(JSON.stringify({ spec: 'deedlog/v0.1', chain: 'c', seq: lines.length, ...prev, collected_at: at, meta: { event, ...meta } }));
  };
  const rule = core.parseRule(HANDLE_INQUIRY, 'handle-inquiry.md');
  const cal = core.parseCalendar(calendar(), 'jp.md');
  const read = (now: string) => {
    const chain = core.parseChain(lines);
    assert.deepEqual(chain.problems, []);
    return { ...core.evaluate(chain.entries, new Date(now)), findings: core.audit(chain.entries, new Date(now)) };
  };
  add('rule.adopted', core.termsToMeta(rule.terms, rule.digest, 'manager'), '2026-11-20T00:00:00Z');
  add('inquiry.received', { item: 'a' }, '2026-11-21T11:37:00Z');
  let r = read('2026-11-22T00:00:00Z');
  assert.deepEqual(r.duties, []);
  assert.deepEqual(r.findings.map((f) => [f.kind, f.seq]), [['no_calendar', 1]]);
  assert.match(r.findings[0]?.message ?? '', /handle-inquiry counts 3bd on calendar jp, which has not been adopted/);
  // Adopted afterwards, its first version is what the waiting clock counts by, from the trigger.
  add(core.CALENDAR_ADOPTED, core.calendarToMeta(cal.terms, cal.digest, 'manager'), '2026-11-22T01:00:00Z');
  const later = core.parseCalendar(calendar(['2026-11-24 closed']), 'jp.md');
  add(core.CALENDAR_ADOPTED, core.calendarToMeta(later.terms, later.digest, 'manager'), '2026-11-22T02:00:00Z');
  r = read('2026-11-22T03:00:00Z');
  assert.deepEqual(r.duties.map((d) => [d.about.item, d.dueAt, d.counted?.calendarVersion]), [['a', '2026-11-26T15:00:00Z', 1]]);
  assert.deepEqual(r.calendars.map((c) => [c.id, c.version, c.seq]), [['jp', 1, 2], ['jp', 2, 3]]);
  assert.deepEqual(core.calendarsInForce(r.calendars).map((c) => c.version), [2]);
});

test('a deadline that runs past the calendar is counted by the weekend alone, and says so', async () => {
  const w = await inForce(calendar([], '2026-12-31'));
  w.at('2026-12-28T01:00:00Z'); // Monday; closed Dec 29 to 31, and the calendar ends there
  await w.t.record('inquiry.received', { item: 'q' });
  // Jan 1 is a holiday, but this calendar does not know 2027: Friday the 1st, Monday the 4th, Tuesday the 5th.
  const d = (await w.t.duties())[0] as core.Duty;
  assert.deepEqual([d.dueAt, d.counted?.lastDay, d.counted?.beyondCalendar], ['2027-01-05T15:00:00Z', '2027-01-05', true]);
  const fs = await w.t.audit();
  assert.deepEqual(fs.map((f) => f.kind), ['beyond_calendar', 'not_told']);
  assert.match(fs[0]?.message ?? '', /the deadline for item q was counted beyond what calendar jp version 1 covers/);
  // A calendar for the new year, adopted now, counts what starts from here on. The duty under way keeps its deadline, and the finding with it.
  await w.t.adoptCalendar(await w.cal(calendar()), 'manager');
  await w.t.record('inquiry.received', { item: 'r' });
  assert.deepEqual((await w.t.duties()).map((x) => [x.about.item, x.dueAt, x.counted?.calendarVersion, x.counted?.beyondCalendar]), [
    ['q', '2027-01-05T15:00:00Z', 1, true],
    ['r', '2027-01-06T15:00:00Z', 2, undefined],
  ]);
  // A person can set it aside; then it is no longer a finding.
  await w.t.except(d.id, 'manager', 'counted before the 2027 calendar');
  assert.deepEqual((await w.t.audit()).map((f) => [f.kind, f.duty === d.id]), [['not_told', false]]);
});

test('notice in business days: the duty comes up at the start of the last of them', async () => {
  const w = await workspace('2026-11-02T00:00:00Z');
  await w.t.adoptCalendar(await w.cal(calendar()), 'manager');
  const withNotice = (n: string) => HANDLE_INQUIRY.replace('within: 3bd', `within: 3bd\nnotice: ${n}`);
  await w.t.adopt(await w.rule('handle-inquiry.md', withNotice('1bd')), 'manager');
  w.at('2026-11-21T11:37:00Z');
  await w.t.record('inquiry.received', { item: 'q' });
  let d = (await w.t.duties())[0] as core.Duty;
  // Comes up when Thursday begins in Tokyo.
  assert.deepEqual([d.status, d.noticeAt, d.dueAt], ['waiting', '2026-11-25T15:00:00Z', '2026-11-26T15:00:00Z']);
  w.at('2026-11-25T15:00:00Z');
  assert.equal((await w.t.duties())[0]?.status, 'due');
  // Two business days before the end: when Wednesday begins. In hours: that long before the end.
  await w.t.adopt(await w.rule('handle-inquiry.md', withNotice('2bd')), 'manager');
  await w.t.record('inquiry.received', { item: 'r' });
  await w.t.adopt(await w.rule('handle-inquiry.md', withNotice('12h')), 'manager');
  await w.t.record('inquiry.received', { item: 's' });
  await w.t.adopt(await w.rule('handle-inquiry.md', withNotice('30d')), 'manager');
  await w.t.record('inquiry.received', { item: 't' });
  const ds = await w.t.duties();
  d = ds[1] as core.Duty;
  assert.deepEqual(ds.map((x) => [x.about.item, x.version, x.noticeAt, x.dueAt]), [
    ['q', 1, '2026-11-25T15:00:00Z', '2026-11-26T15:00:00Z'],
    ['r', 2, '2026-11-29T15:00:00Z', '2026-12-01T15:00:00Z'], // received Thursday: Friday, Monday, Tuesday
    ['s', 3, '2026-12-01T03:00:00Z', '2026-12-01T15:00:00Z'],
    ['t', 4, '2026-11-25T15:00:00Z', '2026-12-01T15:00:00Z'], // no earlier than the start
  ]);
});

test('rule files: business days are written as bd and name their calendar', () => {
  const r = parseRule(HANDLE_INQUIRY, 'handle-inquiry.md');
  assert.deepEqual([r.terms.within, r.terms.notice, r.terms.calendar], ['3bd', '3bd', 'jp']);
  assert.deepEqual(parseRule(formatRule(r.terms, r.text)).terms, r.terms);
  assert.deepEqual(core.span('3bd'), { n: 3, unit: 'bd' });
  assert.throws(() => core.duration('3bd'), /counted on a calendar/);
  // A rule in d, h or m is written into the chain exactly as before.
  assert.ok(!('calendar' in core.termsToMeta(parseRule(DELETE_AFTER_ANSWER).terms, 'x', 'legal')));
  assert.equal(core.termsToMeta(r.terms, 'x', 'manager').calendar, 'jp');
  const bad = (body: string, line: number | undefined, re: RegExp) => assert.throws(() => parseRule(body), (e: RuleError) => e instanceof RuleError && e.line === line && re.test(e.message), body);
  bad(HANDLE_INQUIRY.replace('calendar: jp\n', ''), 6, /business days are counted on a calendar; name it with calendar:/);
  bad(HANDLE_INQUIRY.replace('within: 3bd', 'within: 3d'), 7, /calendar: only for a deadline in business days/);
  bad(HANDLE_INQUIRY.replace('calendar: jp', 'calendar: Japan!'), 7, /the id of a calendar/);
  bad(HANDLE_INQUIRY.replace('within: 3bd', 'within: 3bd\nnotice: 4bd'), 7, /cannot be longer than the deadline/);
  bad(HANDLE_INQUIRY.replace('within: 3bd', 'within: 0bd'), 6, /more than nothing/);
  bad(HANDLE_INQUIRY.replace('within: 3bd', 'within: 3 business days'), 6, /not a duration; write a number and d, h or m, e.g. 30d, or bd for business days/);
  bad(DELETE_AFTER_ANSWER.replace('notice: 7d', 'notice: 5bd'), 8, /in business days only when within is in business days/);
});

test('a calendar file reads into its days, and one that is wrong says which line and why', () => {
  const c = parseCalendar(calendar(), 'jp.md');
  assert.deepEqual(c.terms, { id: 'jp', title: 'Holidays in Japan and the days the office is closed', timezone: '+09:00', weekend: ['sat', 'sun'], from: '2026-01-01', until: '2027-12-31', closed: ['2026-11-03', '2026-11-23', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-11'] });
  assert.equal(c.labels['2026-11-23'], 'Labour Thanksgiving Day');
  assert.match(c.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseCalendar(calendar().replace('weekend: sat, sun', 'weekend: none')).terms.weekend, []);
  assert.deepEqual(parseCalendar(calendar().replace('weekend: sat, sun\n', '')).terms.weekend, ['sat', 'sun']);
  // The example in the repository is a calendar.
  const jp = parseCalendar(readFileSync(join(ROOT, 'examples', 'calendars', 'jp.md')), 'jp.md');
  assert.deepEqual([jp.terms.closed.length, jp.terms.closed.includes('2026-11-23')], [35, true]);

  const bad = (body: string, line: number | undefined, re: RegExp, name?: string) => assert.throws(() => parseCalendar(body, name), (e: RuleError) => e instanceof RuleError && e.line === line && re.test(e.message), body);
  const edit = (from: string, to: string) => calendar().replace(from, to);
  bad('id: jp\n', 1, /begins with a line of ---/);
  bad('---\nid: jp\n', undefined, /end with a line of ---/);
  bad(edit('timezone: +09:00', 'timezone: Asia/Tokyo'), 4, /a fixed offset from UTC, e\.g\. \+09:00/);
  bad(edit('timezone: +09:00\n', ''), undefined, /timezone: required/);
  bad(edit('weekend: sat, sun', 'weekend: saturday'), 5, /weekend "saturday"/);
  bad(edit('until: 2027-12-31', 'until: 2025-12-31'), 7, /cannot be before from/);
  bad(edit('from: 2026-01-01', 'from: 2026-02-30'), 6, /a day, e\.g\. 2026-01-01/);
  bad(edit('2026-11-23 Labour', '2026-11-31 Labour'), 10, /"2026-11-31" is not a day/);
  bad(edit('2026-11-23 Labour', '2028-01-01 Labour'), 10, /outside the days the calendar covers/);
  bad(edit('2026-11-23 Labour', '2026-11-03 Labour'), 9, /given twice/);
  bad(edit('2026-11-23 Labour', '2026-10-01 Labour'), 10, /not in order/);
  bad(edit('weekend: sat, sun', 'holiday: sat'), 5, /not a key of a calendar/);
  bad(calendar(), 2, /a calendar lives in jp\.md/, 'japan.md');
});

test('a chain written by tsutome 0.1.1 reads as 0.1.1 read it', () => {
  // The fixtures were written by the published 0.1.1: the chain, and what it computed from it at three times.
  const lines = readFileSync(join(ROOT, 'test', 'fixtures', 'chain-0.1.1.jsonl'), 'utf8').split('\n').filter(Boolean);
  const was = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'computed-0.1.1.json'), 'utf8')) as { [at: string]: { duties: core.Duty[]; audit: core.Finding[] } };
  const chain = core.parseChain(lines);
  assert.deepEqual(chain.problems, []);
  assert.equal(lines.length, 13);
  assert.ok(lines.every((l) => l.includes('"collector":"tsutome 0.1.1"')));
  assert.equal(Object.keys(was).length, 3);
  for (const [at, w] of Object.entries(was)) {
    assert.ok(w.duties.length >= 3, at);
    assert.deepEqual(JSON.parse(JSON.stringify(core.evaluate(chain.entries, new Date(at)).duties)), w.duties, at);
    assert.deepEqual(JSON.parse(JSON.stringify(core.audit(chain.entries, new Date(at)))), w.audit, at);
  }
  // In it, the inquiry of Saturday night under three calendar days and under five: neither counts business days.
  const sat = was['2026-11-25T00:00:00Z']?.duties.find((d) => d.about.item === 'sat');
  assert.deepEqual([sat?.version, sat?.dueAt, sat?.counted], [2, '2026-11-26T11:37:00Z', undefined]);
});

test('the command line: a calendar checked and adopted, and a deadline shown with how it was counted', async () => {
  const w = await workspace();
  const cal = await w.cal(calendar());
  const rule = await w.rule('handle-inquiry.md', HANDLE_INQUIRY);
  const env = { ...process.env, TSUTOME_CHAIN: w.opts.chain, TSUTOME_RULES: w.opts.rules };
  const t = (args: string[], now = '2026-11-20T00:00:00Z') => run('node', [CLI, ...args, '--now', now, '--name', 'cli.test'], { env });
  const fails = async (args: string[], now?: string) => {
    try {
      await t(args, now);
    } catch (e) {
      return e as { code: number; stdout: string; stderr: string };
    }
    throw new Error(`${args.join(' ')} did not fail`);
  };
  assert.match((await t(['check-calendar', cal])).stdout, /jp\.md: ok {2}2026-01-01 to 2027-12-31, \+09:00, closed on sat, sun and 7 other days/);
  await writeFile(join(w.dir, 'calendars', 'bad.md'), calendar().replace('id: jp', 'id: bad').replace('+09:00', 'JST'));
  assert.match((await fails(['check-calendar', join(w.dir, 'calendars', 'bad.md')])).stderr, /bad\.md:4: timezone "JST": a fixed offset/);
  assert.match((await t(['check', rule])).stdout, /ok {2}when inquiry\.received, inquiry\.answered within 3bd by calendar jp, owner support/);
  assert.match((await fails(['adopt', rule, '--by', 'manager'])).stderr, /calendar jp, which has not been adopted/);
  assert.match((await fails(['adopt-calendar', cal])).stderr, /--by NAME, who adopts it/);
  assert.match((await t(['adopt-calendar', cal, '--by', 'manager'])).stdout, /adopted calendar jp version 1 \(record 0, sha256 [0-9a-f]{12}\), 2026-01-01 to 2027-12-31/);
  assert.match((await t(['calendars'])).stdout, /^invalid {3}bad {2}line 4: timezone .*\nadopted {3}jp {2}version 1, 2026-01-01 to 2027-12-31 \+09:00, adopted by manager 2026-11-20T00:00:00Z$/m);
  await t(['adopt', rule, '--by', 'manager']);
  await t(['record', 'inquiry.received', '-m', 'item=q1', '--by', 'site'], '2026-11-21T11:37:00Z');
  assert.match((await t(['duties'], '2026-11-24T12:00:00Z')).stdout, /^[0-9a-f]{12} {2}due {8}due 2026-11-26T15:00:00Z \(the end of 2026-11-26 \+09:00, 3 business days by calendar jp version 1\) {2}support {2}handle-inquiry: inquiry\.answered for item q1$/m);
  const audit = await fails(['audit'], '2026-11-27T00:00:00Z');
  assert.match(audit.stdout, /^line 3: overdue: handle-inquiry: inquiry\.answered for item q1 was due 2026-11-26T15:00:00Z \(the end of 2026-11-26 \+09:00, 3 business days by calendar jp version 1\) and has not happened$/m);
  assert.match((await t(['verify'])).stdout, /3 records hold together/);
});

test('deedlog verifies a chain with a calendar in it (set DLOG to the dlog binary to run this)', { skip: !process.env.DLOG }, async () => {
  const w = await inForce(readFileSync(join(ROOT, 'examples', 'calendars', 'jp.md'), 'utf8'));
  await w.t.record('inquiry.received', { item: 'q1' }, 'site');
  const { stdout } = await run(process.env.DLOG as string, ['verify', w.opts.chain]);
  const v = JSON.parse(stdout) as { chain: string; count: number; head: string };
  assert.deepEqual([v.chain, v.count, v.head], ['example.test/duties', 3, 'sha256:' + (await w.t.verify()).head]);
});

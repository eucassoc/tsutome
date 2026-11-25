// Business days. Which days are closed cannot be computed: holidays move by
// law, and an office has days of its own. So the calendar is data from
// outside, and it is treated as a rule is: a file a person can read, put in
// force by a person, and kept in the chain, days and all. Anyone holding the
// chain counts the same business days, and a calendar adopted later does not
// move a deadline that was counted under an earlier one.
//
//   ---
//   id: jp
//   title: Holidays in Japan and the days the office is closed
//   source: Cabinet Office, "National holidays"
//   timezone: +09:00
//   weekend: sat, sun
//   from: 2026-01-01
//   until: 2027-12-31
//   ---
//   2026-01-01 New Year's Day
//   2026-01-12 Coming of Age Day
//
// The zone is a fixed offset from UTC on purpose: a zone by name is read
// from a table that differs between machines and changes over the years, and
// two readers of one chain must find the same midnight.
import { sha256, type Entry } from './record.js';
import { RuleError } from './rulefile.js';

export const CALENDAR_ADOPTED = 'tsutome.calendar_adopted';
const DAY = 86_400_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KEYS = ['id', 'title', 'source', 'timezone', 'weekend', 'from', 'until'];

export interface CalendarTerms {
  id: string;
  title: string;
  source?: string;
  /** A fixed offset from UTC, `+09:00`. Days begin and end at midnight there. */
  timezone: string;
  /** The days of the week that are closed every week: `sat`, `sun`. */
  weekend: string[];
  /** The first and last day the calendar speaks for. Outside them only the weekend is known. */
  from: string;
  until: string;
  /** The closed days besides the weekend, in order. */
  closed: string[];
}

export interface CalendarFile {
  terms: CalendarTerms;
  /** What the file says each closed day is. Not kept in the chain. */
  labels: { [date: string]: string };
  /** SHA-256 of the file's bytes: what an adoption commits to. */
  digest: string;
}

/** A calendar as adopted: its days at that point of the chain. */
export interface Calendar extends CalendarTerms {
  version: number;
  seq: number;
  adoptedAt: string;
  adoptedBy: string;
  digest: string;
}

/** A day as a count of days since 1970-01-01, or NaN if it is not a day of the calendar. */
export function dayNumber(date: string): number {
  const m = DATE.exec(date);
  if (!m) return NaN;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === date ? ms / DAY : NaN;
}

export const dayName = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);

/** `+09:00` in minutes, or NaN. */
export function offsetMinutes(tz: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) return NaN;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Checks a calendar's terms, wherever they came from. */
export function checkCalendar(t: CalendarTerms, lineOf: (key: string) => number | undefined = () => undefined): void {
  const fail = (key: string, message: string): never => {
    throw new RuleError(message, lineOf(key));
  };
  if (!ID.test(t.id)) fail('id', `id ${JSON.stringify(t.id)}: lowercase letters, digits and hyphens, at most 40`);
  if (!t.title || t.title.length > 120) fail('title', 'title: required, at most 120 characters');
  if (t.source !== undefined && t.source.length > 200) fail('source', 'source: at most 200 characters');
  if (Number.isNaN(offsetMinutes(t.timezone))) fail('timezone', `timezone ${JSON.stringify(t.timezone)}: a fixed offset from UTC, e.g. +09:00; a zone by name is not read the same everywhere`);
  for (const d of t.weekend) if (!WEEKDAYS.includes(d)) fail('weekend', `weekend ${JSON.stringify(d)}: ${WEEKDAYS.join(', ')}, or none`);
  if (new Set(t.weekend).size !== t.weekend.length) fail('weekend', 'weekend: a day appears twice');
  if (t.weekend.length > 6) fail('weekend', 'weekend: a week needs a day that is open');
  for (const k of ['from', 'until'] as const) if (Number.isNaN(dayNumber(t[k]))) fail(k, `${k} ${JSON.stringify(t[k])}: a day, e.g. 2026-01-01`);
  if (dayNumber(t.from) > dayNumber(t.until)) fail('until', 'until: cannot be before from');
  if (dayNumber(t.until) - dayNumber(t.from) > 366 * 30) fail('until', 'until: a calendar covers at most 30 years');
  let last = -Infinity;
  for (const d of t.closed) {
    const n = dayNumber(d);
    if (Number.isNaN(n)) fail(d, `${JSON.stringify(d)} is not a day; write e.g. 2026-01-01`);
    if (n < dayNumber(t.from) || n > dayNumber(t.until)) fail(d, `${d}: outside the days the calendar covers, ${t.from} to ${t.until}`);
    if (n === last) fail(d, `${d}: given twice`);
    if (n < last) fail(d, `${d}: the days are not in order`);
    last = n;
  }
}

/** Reads a calendar file. `name` is the file's name, which must be the calendar's id and `.md`. */
export function parseCalendar(bytes: Uint8Array | string, name?: string): CalendarFile {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const lines = new TextDecoder().decode(buf).split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0]?.trim() !== '---') throw new RuleError('a calendar file begins with a line of ---', 1);
  const raw: { [k: string]: string } = {};
  const at: { [k: string]: number } = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '---') break;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_]\w*):(.*)$/.exec(line);
    if (!m) throw new RuleError(`not "key: value": ${JSON.stringify(line.trim())}`, i + 1);
    const key = m[1] as string;
    if (!KEYS.includes(key)) throw new RuleError(`${key}: not a key of a calendar; the keys are ${KEYS.join(', ')}`, i + 1);
    if (key in at) throw new RuleError(`${key}: given twice`, i + 1);
    at[key] = i + 1;
    raw[key] = (m[2] as string).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (i >= lines.length) throw new RuleError('the terms end with a line of ---');
  const need = (k: string): string => {
    if (!raw[k]) throw new RuleError(`${k}: required`, at[k]);
    return raw[k] as string;
  };
  const closed: string[] = [];
  const labels: { [d: string]: string } = {};
  for (let j = i + 1; j < lines.length; j++) {
    const line = (lines[j] as string).trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)(?:\s+(.*))?$/.exec(line) as RegExpExecArray;
    const date = m[1] as string;
    if (Number.isNaN(dayNumber(date))) throw new RuleError(`${JSON.stringify(date)} is not a day; each line below the terms is a closed day, e.g. 2026-01-01 New Year's Day`, j + 1);
    at[date] ??= j + 1;
    closed.push(date);
    if (m[2]) labels[date] = m[2];
  }
  const weekend = raw.weekend === undefined ? ['sat', 'sun'] : raw.weekend === 'none' ? [] : raw.weekend.split(',').map((s) => s.trim()).filter(Boolean);
  const terms: CalendarTerms = { id: need('id'), title: need('title'), ...(raw.source ? { source: raw.source } : {}), timezone: need('timezone'), weekend, from: need('from'), until: need('until'), closed };
  checkCalendar(terms, (k) => at[k]);
  if (name !== undefined && name !== `${terms.id}.md`) throw new RuleError(`the file is ${name}, the calendar is ${terms.id}; a calendar lives in ${terms.id}.md`, at.id);
  return { terms, labels, digest: sha256(buf) };
}

/** What a calendar's adoption puts in the chain: every day of it, so that the chain alone is enough to count. */
export function calendarToMeta(t: CalendarTerms, digest: string, by: string): { [key: string]: string } {
  return { calendar: t.id, digest, title: t.title, ...(t.source ? { source: t.source } : {}), timezone: t.timezone, weekend: t.weekend.join(',') || 'none', from: t.from, until: t.until, closed: t.closed.join(','), by };
}

/** Every version of every calendar, in the order adopted. */
export function calendarsFrom(entries: Entry[]): Calendar[] {
  const out: Calendar[] = [];
  for (const e of entries) {
    const m = e.meta;
    if (e.event !== CALENDAR_ADOPTED || !m.calendar) continue;
    out.push({
      id: m.calendar,
      title: m.title ?? m.calendar,
      ...(m.source ? { source: m.source } : {}),
      timezone: m.timezone ?? '+00:00',
      weekend: !m.weekend || m.weekend === 'none' ? [] : m.weekend.split(','),
      from: m.from ?? '',
      until: m.until ?? '',
      closed: (m.closed ?? '').split(',').filter(Boolean),
      version: out.filter((c) => c.id === m.calendar).length + 1,
      seq: e.seq,
      adoptedAt: e.at,
      adoptedBy: m.by ?? '',
      digest: m.digest ?? '',
    });
  }
  return out;
}

/** The calendars in force now: the latest version of each. */
export function calendarsInForce(all: Calendar[]): Calendar[] {
  const latest = new Map<string, Calendar>();
  for (const c of all) latest.set(c.id, c);
  return [...latest.values()];
}

/**
 * The version of a calendar a clock that starts at record `seq` counts by:
 * the latest adopted before it. A clock that started before the calendar's
 * first adoption counts by that first version: until then there was no
 * deadline to tell, and from then on it does not move.
 */
export function governingCalendar(all: Calendar[], id: string, seq: number): Calendar | undefined {
  let pick: Calendar | undefined;
  let first: Calendar | undefined;
  for (const c of all) {
    if (c.id !== id) continue;
    first ??= c;
    if (c.seq < seq) pick = c;
  }
  return pick ?? first;
}

export interface Counted {
  /** The instant the last day ends: midnight in the calendar's zone. */
  dueMs: number;
  /** The instant the duty comes up. */
  noticeMs: number;
  /** The last day on which the duty can still be met in time, in the calendar's zone. */
  lastDay: string;
  /** A day beyond what the calendar covers was counted, by the weekend alone. */
  beyond: boolean;
}

/**
 * Counts `n` business days from `startMs`. The day of the start is not
 * counted, whether it is a business day or not; the deadline is the end of
 * the n-th business day after it. `noticeDays` business days before the end
 * the duty comes up: at the start of the last `noticeDays` business days, or
 * from the start when that is the whole period. `noticeMs` is used instead
 * when the notice is written in d, h or m.
 */
export function countBusinessDays(cal: Calendar, startMs: number, n: number, notice: { days: number } | { ms: number }): Counted {
  const off = offsetMinutes(cal.timezone) * 60_000;
  const from = dayNumber(cal.from);
  const until = dayNumber(cal.until);
  const weekend = new Set(cal.weekend.map((d) => WEEKDAYS.indexOf(d)));
  const closed = new Set(cal.closed.map(dayNumber));
  let beyond = false;
  const open = (day: number): boolean => {
    if (!(day >= from && day <= until)) beyond = true;
    // 1970-01-01 was a Thursday.
    return !weekend.has((((day + 4) % 7) + 7) % 7) && !closed.has(day);
  };
  let day = Math.floor((startMs + off) / DAY);
  for (let c = 0; c < n; ) if (open(++day)) c += 1;
  const dueMs = (day + 1) * DAY - off;
  let noticeMs: number;
  if ('ms' in notice) noticeMs = Math.max(startMs, dueMs - notice.ms);
  else if (notice.days <= 0) noticeMs = dueMs;
  else if (notice.days >= n) noticeMs = startMs;
  else {
    let back = day;
    for (let c = 1; c < notice.days; ) if (open(--back)) c += 1;
    noticeMs = Math.max(startMs, back * DAY - off);
  }
  return { dueMs, noticeMs, lastDay: dayName(day), beyond };
}

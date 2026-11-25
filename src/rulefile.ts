// A rule is a file a person can read and review: the terms a machine acts
// on at the top, the words of the policy below.
//
//   ---
//   id: delete-after-answer
//   title: Delete inquiries 30 days after they are answered
//   source: Personal data policy, article 12.1
//   when: data.answered
//   expect: data.deleted
//   within: 30d
//   notice: 7d
//   calendar: jp        (only with business days: `within: 3bd`)
//   owner: support
//   escalate: legal
//   per: item
//   approval: required
//   where:
//     form: contact
//   ---
//   Inquiries are deleted within 30 days of the day they are answered.
//
// The format is strict on purpose: one `key: value` per line, no lists, no
// multi-line values. A file that does not parse says which line and why.
import { sha256 } from './record.js';

export interface Terms {
  id: string;
  title: string;
  /** Where the rule comes from: the clause of a policy, a law, a contract. */
  source?: string;
  /** The event that starts the clock. */
  when: string;
  /** The event that must follow. */
  expect: string;
  /** How long after `when`, e.g. `30d`, `12h`, or in business days, `3bd`. */
  within: string;
  /** How long before the deadline the duty comes up and the owner is told. Left out: from the start. */
  notice: string;
  /** The calendar business days are counted by. Given when `within` is in business days, and only then. */
  calendar?: string;
  /** Who must act. A role, not a person's name. */
  owner: string;
  /** Who is told when the deadline has passed. */
  escalate: string;
  /** The meta keys that name the thing a duty is about: one duty per distinct combination. */
  per: string[];
  /** `required`: a person approves before the expected event; done without approval is a finding. */
  approval: 'required' | 'none';
  /** Only triggers whose meta equal these give rise to a duty. */
  where: { [key: string]: string };
}

export interface RuleFile {
  terms: Terms;
  /** The words of the policy, below the terms. */
  text: string;
  /** SHA-256 of the file's bytes: what an adoption commits to. */
  digest: string;
}

export class RuleError extends Error {
  constructor(
    message: string,
    /** The line of the file, when one line is at fault. */
    readonly line?: number,
  ) {
    super(message);
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EVENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,5}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const ACTOR = /^[A-Za-z0-9][\w.@-]{0,63}$/;
const KEYS = ['id', 'title', 'source', 'when', 'expect', 'within', 'notice', 'calendar', 'owner', 'escalate', 'per', 'approval', 'where'];
/** Event names tsutome writes itself; a rule cannot wait on them or be met by them. */
export const RESERVED = ['rule.', 'duty.', 'tsutome.'];

export const isEvent = (s: string): boolean => EVENT.test(s) && s.length <= 64;
export const isKey = (s: string): boolean => KEY.test(s);
export const isActor = (s: string): boolean => ACTOR.test(s);
export const isReserved = (event: string): boolean => RESERVED.some((p) => event.startsWith(p));

/** A length of time as a rule writes it: `30d`, `12h`, `45m`, or `3bd` for business days. */
export interface Span {
  n: number;
  unit: 'd' | 'h' | 'm' | 'bd';
}

export function span(s: string): Span {
  const m = /^(\d{1,5})(bd|[dhm])$/.exec(s);
  if (!m || (m[2] === 'bd' && Number(m[1]) > 999)) throw new RuleError(`${JSON.stringify(s)} is not a duration; write a number and d, h or m, e.g. 30d, or bd for business days, e.g. 3bd`);
  return { n: Number(m[1]), unit: m[2] as Span['unit'] };
}

export const isBusinessDays = (s: string): boolean => /^\d+bd$/.test(s);

/** `30d`, `12h`, `45m` in milliseconds. Business days have no fixed length: they are counted on a calendar. */
export function duration(s: string): number {
  const { n, unit } = span(s);
  if (unit === 'bd') throw new RuleError(`${JSON.stringify(s)} is in business days, which are counted on a calendar and have no fixed length`);
  return n * { d: 86_400_000, h: 3_600_000, m: 60_000 }[unit];
}

const unquote = (v: string): string => (/^"(.*)"$/.exec(v)?.[1] ?? /^'(.*)'$/.exec(v)?.[1] ?? v);

/** Checks terms, wherever they came from. Throws on the first thing wrong. */
export function checkTerms(t: Terms, lineOf: (key: string) => number | undefined = () => undefined): void {
  const fail = (key: string, message: string): never => {
    throw new RuleError(message, lineOf(key));
  };
  if (!ID.test(t.id)) fail('id', `id ${JSON.stringify(t.id)}: lowercase letters, digits and hyphens, at most 40`);
  if (!t.title || t.title.length > 120) fail('title', 'title: required, at most 120 characters');
  if (t.source !== undefined && t.source.length > 200) fail('source', 'source: at most 200 characters');
  for (const k of ['when', 'expect'] as const) {
    if (!isEvent(t[k])) fail(k, `${k} ${JSON.stringify(t[k])}: an event name like data.deleted (lowercase words joined by dots)`);
    if (isReserved(t[k])) fail(k, `${k} ${JSON.stringify(t[k])}: events starting with ${RESERVED.join(', ')} are tsutome's own`);
  }
  if (t.when === t.expect) fail('expect', 'expect: the event that must follow cannot be the one that starts the clock');
  let within: Span = { n: 0, unit: 'd' };
  let notice: Span = { n: 0, unit: 'd' };
  try {
    within = span(t.within);
  } catch (e) {
    fail('within', `within: ${(e as Error).message}`);
  }
  try {
    notice = span(t.notice);
  } catch (e) {
    fail('notice', `notice: ${(e as Error).message}`);
  }
  if (within.n <= 0) fail('within', 'within: must be more than nothing');
  if (within.unit === 'bd') {
    // A notice in d, h or m against a deadline in business days cannot be compared here; it comes up no earlier than the start.
    if (notice.unit === 'bd' && notice.n > within.n) fail('notice', 'notice: cannot be longer than the deadline itself');
    if (!t.calendar) fail('within', 'within: business days are counted on a calendar; name it with calendar:');
    else if (!ID.test(t.calendar)) fail('calendar', `calendar ${JSON.stringify(t.calendar)}: the id of a calendar (lowercase letters, digits and hyphens)`);
  } else {
    if (notice.unit === 'bd') fail('notice', 'notice: in business days only when within is in business days');
    else if (duration(t.notice) > duration(t.within)) fail('notice', 'notice: cannot be longer than the deadline itself');
    if (t.calendar !== undefined) fail('calendar', 'calendar: only for a deadline in business days, e.g. within: 3bd');
  }
  for (const k of ['owner', 'escalate'] as const) if (!isActor(t[k])) fail(k, `${k} ${JSON.stringify(t[k])}: a short name for a role, letters, digits and . _ @ - only`);
  if (!t.per.length || t.per.length > 4) fail('per', 'per: one to four meta keys');
  for (const k of t.per) if (!isKey(k)) fail('per', `per ${JSON.stringify(k)}: a meta key (lowercase letters, digits, underscores)`);
  if (new Set(t.per).size !== t.per.length) fail('per', 'per: a key appears twice');
  if (t.approval !== 'required' && t.approval !== 'none') fail('approval', 'approval: required or none');
  for (const [k, v] of Object.entries(t.where)) {
    if (!isKey(k)) fail('where', `where ${JSON.stringify(k)}: a meta key (lowercase letters, digits, underscores)`);
    if (!v || v.length > 128) fail('where', `where ${k}: a value of at most 128 characters`);
  }
}

/** Reads a rule file. `name` is the file's name, which must be the rule's id and `.md`. */
export function parseRule(bytes: Uint8Array | string, name?: string): RuleFile {
  const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const lines = new TextDecoder().decode(buf).split('\n');
  if (lines[0]?.trim() !== '---') throw new RuleError('a rule file begins with a line of ---', 1);
  const raw: { [k: string]: string } = {};
  const where: { [k: string]: string } = {};
  const at: { [k: string]: number } = {};
  let i = 1;
  let inWhere = false;
  for (; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, '');
    const n = i + 1;
    if (line.trim() === '---') break;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z_][\w]*):(.*)$/.exec(line);
    if (!m) throw new RuleError(`not "key: value": ${JSON.stringify(line.trim())}`, n);
    const [, indent, key, rest] = m as unknown as [string, string, string, string];
    const value = unquote(rest.trim());
    if (indent) {
      if (!inWhere) throw new RuleError(`${key}: only the lines under where: are indented`, n);
      if (key in where) throw new RuleError(`where ${key}: given twice`, n);
      where[key] = value;
      continue;
    }
    inWhere = key === 'where';
    if (!KEYS.includes(key)) throw new RuleError(`${key}: not a key of a rule; the keys are ${KEYS.join(', ')}`, n);
    if (key in at) throw new RuleError(`${key}: given twice`, n);
    at[key] = n;
    if (inWhere) {
      if (value) throw new RuleError('where: its conditions go on the lines below, indented', n);
    } else raw[key] = value;
  }
  if (i >= lines.length) throw new RuleError('the terms end with a line of ---');
  const need = (k: string): string => {
    if (!raw[k]) throw new RuleError(`${k}: required`, at[k]);
    return raw[k] as string;
  };
  const terms: Terms = {
    id: need('id'),
    title: need('title'),
    ...(raw.source ? { source: raw.source } : {}),
    when: need('when'),
    expect: need('expect'),
    within: need('within'),
    notice: raw.notice || need('within'),
    ...(raw.calendar ? { calendar: raw.calendar } : {}),
    owner: need('owner'),
    escalate: raw.escalate || need('owner'),
    per: (raw.per || 'item').split(',').map((s) => s.trim()).filter(Boolean),
    approval: (raw.approval || 'none') as Terms['approval'],
    where,
  };
  checkTerms(terms, (k) => at[k]);
  if (name !== undefined && name !== `${terms.id}.md`) throw new RuleError(`the file is ${name}, the rule is ${terms.id}; a rule lives in ${terms.id}.md`, at.id);
  return { terms, text: lines.slice(i + 1).join('\n').trim(), digest: sha256(buf) };
}

/** Writes a rule file from terms and the words of the policy. What `parseRule` reads back is the same. */
export function formatRule(terms: Terms, text: string): string {
  checkTerms(terms);
  for (const [k, v] of Object.entries({ title: terms.title, source: terms.source ?? '', ...terms.where })) {
    if (/[\n\r]/.test(v)) throw new RuleError(`${k}: one line only`);
    if (/^["']|["']$/.test(v.trim()) || v !== v.trim()) throw new RuleError(`${k}: cannot begin or end with a quote or a space`);
  }
  const out = ['---', `id: ${terms.id}`, `title: ${terms.title}`];
  if (terms.source) out.push(`source: ${terms.source}`);
  out.push(`when: ${terms.when}`, `expect: ${terms.expect}`, `within: ${terms.within}`, `notice: ${terms.notice}`, ...(terms.calendar ? [`calendar: ${terms.calendar}`] : []), `owner: ${terms.owner}`, `escalate: ${terms.escalate}`, `per: ${terms.per.join(', ')}`, `approval: ${terms.approval}`);
  if (Object.keys(terms.where).length) out.push('where:', ...Object.entries(terms.where).map(([k, v]) => `  ${k}: ${v}`));
  out.push('---', text.trim(), '');
  return out.join('\n');
}

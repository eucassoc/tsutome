// From what happened to what is due. Everything is read from the chain: the
// rules as they were adopted, the triggers, and the events that met them.
// Nothing is kept on the side, so that anyone holding the chain computes the
// same duties, and what was due yesterday cannot be quietly changed today.
import { createHash } from 'node:crypto';
import type { Entry } from './record.js';
import { duration, type Terms } from './rulefile.js';

/** A rule as adopted: its terms at that point of the chain. */
export interface Rule extends Terms {
  /** Counts up with each adoption of the same id. */
  version: number;
  /** The record of the adoption. */
  seq: number;
  adoptedAt: string;
  adoptedBy: string;
  /** SHA-256 of the rule file that was adopted. */
  digest: string;
  /** The record that retired this version, if it was retired and not replaced. */
  retiredSeq?: number;
}

/**
 * `waiting`: the clock runs, and it is not yet time to act. `due`: time to act.
 * `overdue`: the deadline has passed. `done` and `done_late`: met, in time or
 * not. `excepted`: set aside by a person. `withdrawn`: its rule was retired.
 */
export type Status = 'waiting' | 'due' | 'overdue' | 'done' | 'done_late' | 'excepted' | 'withdrawn';
/** What someone is told: that a duty has come up, and that its deadline has passed. */
export type Stage = 'due' | 'overdue';

export interface Duty {
  id: string;
  rule: string;
  version: number;
  title: string;
  /** The thing the duty is about: the values of the rule's `per` keys. */
  about: { [key: string]: string };
  triggerSeq: number;
  triggeredAt: string;
  /** When the clock started: the trigger, or the adoption for what was already there. */
  startsAt: string;
  /** When it comes up: from then on it is time to act. */
  noticeAt: string;
  dueAt: string;
  /** The event that will meet it. */
  expect: string;
  owner: string;
  escalate: string;
  approvalRequired: boolean;
  status: Status;
  done?: { seq: number; at: string; by?: string };
  approved?: { seq: number; by: string; at: string; channel?: string; plan?: string };
  exception?: { seq: number; by: string; at: string };
  /** Stages someone has been told about. */
  alerted: Stage[];
}

export interface Finding {
  kind: 'overdue' | 'late' | 'unapproved' | 'plan_mismatch' | 'not_told' | 'no_key';
  /** The record the finding points at; its line in the file is `seq + 1`. */
  seq: number;
  duty?: string;
  message: string;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A duty's id: the same rule about the same thing is the same duty, whoever computes it. */
export function dutyId(rule: string, about: { [key: string]: string }): string {
  const parts = Object.keys(about).sort().map((k) => `${k}=${about[k]}`);
  return createHash('sha256').update([rule, ...parts].join('\x1f')).digest('hex').slice(0, 12);
}

/** What a rule's adoption puts in the chain, and what is read back from it. */
export function termsToMeta(t: Terms, digest: string, by: string): { [key: string]: string } {
  const meta: { [k: string]: string } = { rule: t.id, digest, title: t.title, when: t.when, expect: t.expect, within: t.within, notice: t.notice, owner: t.owner, escalate: t.escalate, per: t.per.join(','), approval: t.approval, by };
  if (t.source) meta.source = t.source;
  for (const [k, v] of Object.entries(t.where)) meta[`where.${k}`] = v;
  return meta;
}

/** Every version of every rule, in the order adopted. */
export function rulesFrom(entries: Entry[]): Rule[] {
  const rules: Rule[] = [];
  for (const e of entries) {
    const id = e.meta.rule;
    if (!id) continue;
    if (e.event === 'rule.adopted') {
      const m = e.meta;
      const where: { [k: string]: string } = {};
      for (const [k, v] of Object.entries(m)) if (k.startsWith('where.')) where[k.slice(6)] = v;
      rules.push({
        id,
        title: m.title ?? id,
        ...(m.source ? { source: m.source } : {}),
        when: m.when ?? '',
        expect: m.expect ?? '',
        within: m.within ?? '',
        notice: m.notice ?? m.within ?? '',
        owner: m.owner ?? '',
        escalate: m.escalate ?? m.owner ?? '',
        per: (m.per ?? 'item').split(',').filter(Boolean),
        approval: m.approval === 'required' ? 'required' : 'none',
        where,
        version: rules.filter((r) => r.id === id).length + 1,
        seq: e.seq,
        adoptedAt: e.at,
        adoptedBy: m.by ?? '',
        digest: m.digest ?? '',
      });
    } else if (e.event === 'rule.retired') {
      const last = [...rules].reverse().find((r) => r.id === id);
      if (last && last.retiredSeq === undefined) last.retiredSeq = e.seq;
    }
  }
  return rules;
}

/** The rules in force now: the latest version of each that has not been retired. */
export function inForce(rules: Rule[]): Rule[] {
  const latest = new Map<string, Rule>();
  for (const r of rules) latest.set(r.id, r);
  return [...latest.values()].filter((r) => r.retiredSeq === undefined);
}

/** The version of a rule that governs a trigger at `seq`, and whether the rule came after the trigger. */
function governing(versions: Rule[], seq: number): { rule: Rule; later: boolean } | undefined {
  let pick: Rule | undefined;
  for (const r of versions) if (r.seq < seq) pick = r;
  if (pick) return pick.retiredSeq !== undefined && pick.retiredSeq < seq ? undefined : { rule: pick, later: false };
  // What was already there when the rule was first adopted comes under it, from the adoption on.
  const first = versions[0];
  return first ? { rule: first, later: true } : undefined;
}

/** Stages of a duty that have been reached at `now` and that nobody has been told about. */
export function stagesDue(d: Duty, now: Date): Stage[] {
  if (d.status !== 'due' && d.status !== 'overdue') return [];
  const out: Stage[] = now.getTime() >= Date.parse(d.noticeAt) ? ['due'] : [];
  if (d.status === 'overdue') out.push('overdue');
  return out.filter((s) => !d.alerted.includes(s));
}

/** Reads the chain: the duties, and where a trigger could not give rise to one. */
export function evaluate(entries: Entry[], now: Date): { duties: Duty[]; rules: Rule[]; skipped: Finding[] } {
  const rules = rulesFrom(entries);
  const byId = new Map<string, Rule[]>();
  for (const r of rules) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);

  const approved = new Map<string, NonNullable<Duty['approved']>>();
  const excepted = new Map<string, NonNullable<Duty['exception']>>();
  const alerted = new Map<string, Stage[]>();
  const byEvent = new Map<string, Entry[]>();
  for (const e of entries) {
    const duty = e.meta.duty;
    if (duty && e.event === 'duty.approved') approved.set(duty, { seq: e.seq, by: e.meta.by ?? '', at: e.at, ...(e.meta.channel ? { channel: e.meta.channel } : {}), ...(e.meta.plan ? { plan: e.meta.plan } : {}) });
    else if (duty && e.event === 'duty.excepted') excepted.set(duty, { seq: e.seq, by: e.meta.by ?? '', at: e.at });
    else if (duty && e.event === 'duty.exception_ended') excepted.delete(duty);
    else if (duty && e.event === 'duty.alerted' && (e.meta.stage === 'due' || e.meta.stage === 'overdue')) alerted.set(duty, [...(alerted.get(duty) ?? []), e.meta.stage]);
    byEvent.set(e.event, [...(byEvent.get(e.event) ?? []), e]);
  }

  const duties: Duty[] = [];
  const skipped: Finding[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const versions of byId.values()) {
      const g = governing(versions, e.seq);
      if (!g || g.rule.when !== e.event) continue;
      const rule = g.rule;
      if (Object.entries(rule.where).some(([k, v]) => e.meta[k] !== v)) continue;
      const about: { [k: string]: string } = {};
      const missing = rule.per.filter((k) => !e.meta[k]);
      if (missing.length) {
        skipped.push({ kind: 'no_key', seq: e.seq, message: `${e.event} names no ${missing.join(', ')}; rule ${rule.id} cannot tell what it is about` });
        continue;
      }
      for (const k of rule.per) about[k] = e.meta[k] as string;
      const id = dutyId(rule.id, about);
      if (seen.has(id)) continue; // the first trigger starts the clock
      seen.add(id);
      const starts = g.later ? Date.parse(rule.adoptedAt) : Date.parse(e.at);
      const due = starts + duration(rule.within);
      const notice = due - duration(rule.notice);
      const d: Duty = {
        id,
        rule: rule.id,
        version: rule.version,
        title: rule.title,
        about,
        triggerSeq: e.seq,
        triggeredAt: e.at,
        startsAt: iso(starts),
        noticeAt: iso(notice),
        dueAt: iso(due),
        expect: rule.expect,
        owner: rule.owner,
        escalate: rule.escalate,
        approvalRequired: rule.approval === 'required',
        status: 'waiting',
        alerted: alerted.get(id) ?? [],
      };
      const a = approved.get(id);
      if (a) d.approved = a;
      const done = (byEvent.get(rule.expect) ?? []).find((x) => x.seq > e.seq && rule.per.every((k) => x.meta[k] === about[k]));
      const x = excepted.get(id);
      const latest = versions[versions.length - 1] as Rule;
      if (done) {
        d.done = { seq: done.seq, at: done.at, ...(done.meta.by ? { by: done.meta.by } : {}) };
        d.status = Date.parse(done.at) > due ? 'done_late' : 'done';
      } else if (x) {
        d.exception = x;
        d.status = 'excepted';
      } else if (latest.retiredSeq !== undefined) d.status = 'withdrawn';
      else if (now.getTime() > due) d.status = 'overdue';
      else if (now.getTime() >= notice) d.status = 'due';
      duties.push(d);
    }
  }
  return { duties, rules, skipped };
}

/** What an auditor would point at, each with the record where it shows. */
export function audit(entries: Entry[], now: Date): Finding[] {
  const { duties, skipped } = evaluate(entries, now);
  const out: Finding[] = [...skipped];
  const about = (d: Duty) => Object.entries(d.about).map(([k, v]) => `${k} ${v}`).join(', ');
  for (const d of duties) {
    if (d.status === 'overdue') out.push({ kind: 'overdue', seq: d.triggerSeq, duty: d.id, message: `${d.rule}: ${d.expect} for ${about(d)} was due ${d.dueAt} and has not happened` });
    if (d.status === 'done_late' && d.done) out.push({ kind: 'late', seq: d.done.seq, duty: d.id, message: `${d.rule}: ${d.expect} for ${about(d)} came at ${d.done.at}; it was due ${d.dueAt}` });
    if (d.done && d.approvalRequired && !(d.approved && d.approved.seq < d.done.seq)) out.push({ kind: 'unapproved', seq: d.done.seq, duty: d.id, message: `${d.rule}: ${d.expect} for ${about(d)} was done without the approval the rule requires` });
    if (d.done && d.approved?.plan) {
      const did = entries[d.done.seq]?.meta.plan;
      if (did && did !== d.approved.plan) out.push({ kind: 'plan_mismatch', seq: d.done.seq, duty: d.id, message: `${d.rule}: what was done for ${about(d)} is not the plan that was approved` });
    }
    for (const stage of stagesDue(d, now)) out.push({ kind: 'not_told', seq: d.triggerSeq, duty: d.id, message: `${d.rule}: ${stage === 'overdue' ? d.escalate : d.owner} has not been told that ${d.expect} for ${about(d)} is ${stage === 'overdue' ? 'overdue' : 'due'}` });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

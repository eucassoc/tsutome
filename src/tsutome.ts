// The operations, over a chain file and a directory of rule files. There is
// no other state: no database, no server. Two people with the same two
// things see the same duties.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appendRecord, ChainError, readChain, sha256, type Entry, type Problem } from './chain.js';
import { audit, evaluate, inForce, rulesFrom, stagesDue, termsToMeta, type Duty, type Finding, type Rule, type Stage } from './duties.js';
import { formatRule, isActor, isEvent, isKey, isReserved, parseRule, RuleError, type RuleFile, type Terms } from './rulefile.js';

export class TsutomeError extends Error {}

export interface Options {
  /** The chain file. */
  chain: string;
  /** The directory of rule files. */
  rules: string;
  /** The chain's name, for a chain that does not exist yet. */
  name?: string;
  now?: () => Date;
}

/** A rule file next to what the chain says about it. */
export interface RuleState {
  id: string;
  file?: string;
  /**
   * `adopted`: the file is what was adopted. `changed`: the file differs from
   * what was adopted, and gives rise to nothing until adopted. `draft`: never
   * adopted. `invalid`: the file does not parse. `missing`: adopted, the file
   * is gone. `retired`: adopted once, no longer in force.
   */
  state: 'adopted' | 'changed' | 'draft' | 'invalid' | 'missing' | 'retired';
  terms?: Terms;
  adopted?: Rule;
  error?: string;
}

export class Tsutome {
  private readonly now: () => Date;

  constructor(private readonly opts: Options) {
    this.now = opts.now ?? (() => new Date());
  }

  /** The chain, checked. A chain that does not verify is not read further: what is due cannot be told from it. */
  async entries(): Promise<Entry[]> {
    const chain = await readChain(this.opts.chain);
    if (chain.problems.length) {
      const p = chain.problems[0] as Problem;
      throw new ChainError(`${this.opts.chain}: line ${p.line}: ${p.reason}`);
    }
    return chain.entries;
  }

  verify(): Promise<{ entries: Entry[]; head?: string; problems: Problem[] }> {
    return readChain(this.opts.chain);
  }

  private append(event: string, meta: { [k: string]: string | undefined }): Promise<Entry> {
    return appendRecord(this.opts.chain, event, meta, { name: this.opts.name ?? 'tsutome', now: this.now });
  }

  // ---- rules ----------------------------------------------------------------

  /** Reads and checks one rule file. */
  async readRule(path: string): Promise<RuleFile> {
    try {
      return parseRule(await readFile(path), basename(path));
    } catch (e) {
      if (e instanceof RuleError) throw new RuleError(`${path}${e.line ? `:${e.line}` : ''}: ${e.message}`, e.line);
      throw e;
    }
  }

  /**
   * Writes a rule file. It is a draft: it gives rise to nothing until a
   * person adopts it. Writing over an adopted rule's file leaves the adopted
   * terms in force, and shows the file as changed.
   */
  async draft(terms: Terms, text: string): Promise<string> {
    const body = formatRule(terms, text);
    parseRule(body, `${terms.id}.md`);
    await mkdir(this.opts.rules, { recursive: true });
    const path = join(this.opts.rules, `${terms.id}.md`);
    await writeFile(path, body);
    return path;
  }

  /** A person puts a rule in force, as the file stands. The chain keeps its terms and the file's digest. */
  async adopt(path: string, by: string): Promise<Rule> {
    if (!isActor(by)) throw new TsutomeError('adopting a rule names who adopts it');
    const rule = await this.readRule(path);
    const current = inForce(rulesFrom(await this.entries())).find((r) => r.id === rule.terms.id);
    if (current?.digest === rule.digest) throw new TsutomeError(`${rule.terms.id} is already in force as this file stands`);
    const e = await this.append('rule.adopted', termsToMeta(rule.terms, rule.digest, by));
    return rulesFrom(await this.entries()).find((r) => r.seq === e.seq) as Rule;
  }

  /** A rule stops giving rise to duties. What it had started and was not yet done is withdrawn. */
  async retire(id: string, by: string): Promise<void> {
    if (!isActor(by)) throw new TsutomeError('retiring a rule names who retires it');
    if (!inForce(rulesFrom(await this.entries())).some((r) => r.id === id)) throw new TsutomeError(`no rule ${id} in force`);
    await this.append('rule.retired', { rule: id, by });
  }

  /** Every rule file and every adopted rule, side by side. */
  async rules(): Promise<RuleState[]> {
    const all = rulesFrom(await this.entries());
    const live = inForce(all);
    const out: RuleState[] = [];
    let names: string[] = [];
    try {
      names = (await readdir(this.opts.rules)).filter((n) => n.endsWith('.md')).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const seen = new Set<string>();
    for (const name of names) {
      const file = join(this.opts.rules, name);
      const id = name.slice(0, -3);
      seen.add(id);
      const adopted = live.find((r) => r.id === id);
      try {
        const rule = parseRule(await readFile(file), name);
        out.push({ id, file, terms: rule.terms, state: !adopted ? 'draft' : adopted.digest === rule.digest ? 'adopted' : 'changed', ...(adopted ? { adopted } : {}) });
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        out.push({ id, file, state: 'invalid', error: `${e.line ? `line ${e.line}: ` : ''}${e.message}`, ...(adopted ? { adopted } : {}) });
      }
    }
    for (const r of live) if (!seen.has(r.id)) out.push({ id: r.id, state: 'missing', adopted: r });
    const lastOf = new Map<string, Rule>();
    for (const r of all) lastOf.set(r.id, r);
    for (const r of lastOf.values()) if (r.retiredSeq !== undefined && !seen.has(r.id)) out.push({ id: r.id, state: 'retired', adopted: r });
    return out;
  }

  // ---- what happened ---------------------------------------------------------

  /**
   * Records that something happened. `meta` names what it is about, under the
   * keys the rules' `per` and `where` read. Values are identifiers, never
   * personal data: pass a digest or an HMAC for anything that could be guessed.
   */
  async record(event: string, meta: { [k: string]: string }, by?: string): Promise<Entry> {
    if (!isEvent(event)) throw new TsutomeError(`${JSON.stringify(event)} is not an event name; write lowercase words joined by dots, like data.deleted`);
    if (isReserved(event)) throw new TsutomeError(`${event}: events starting with rule., duty. or tsutome. are recorded by their own operations`);
    for (const [k, v] of Object.entries(meta)) {
      if (!isKey(k) || k === 'by' || k === 'event') throw new TsutomeError(`${JSON.stringify(k)} is not a meta key; write lowercase letters, digits and underscores`);
      if (typeof v !== 'string' || !v || v.length > 256 || /[\n\r]/.test(v)) throw new TsutomeError(`${k}: a value of one line, at most 256 characters`);
    }
    if (by !== undefined && !isActor(by)) throw new TsutomeError('by: a short name for who did it');
    return this.append(event, { ...meta, ...(by ? { by } : {}) });
  }

  // ---- duties ----------------------------------------------------------------

  async duties(): Promise<Duty[]> {
    return evaluate(await this.entries(), this.now()).duties;
  }

  async duty(id: string): Promise<{ duty: Duty; records: Entry[] }> {
    const entries = await this.entries();
    const d = evaluate(entries, this.now()).duties.find((x) => x.id === id);
    if (!d) throw new TsutomeError(`no duty ${id}`);
    const records = entries.filter((e) => e.meta.duty === id || ((e.event === d.expect || e.seq === d.triggerSeq) && Object.entries(d.about).every(([k, v]) => e.meta[k] === v)));
    return { duty: d, records };
  }

  /** What there is to do now: whom to tell, and what waits for approval or for doing. */
  async agenda(): Promise<{ tell: { duty: Duty; stage: Stage; to: string }[]; approve: Duty[]; act: Duty[] }> {
    const duties = await this.duties();
    const now = this.now();
    const live = duties.filter((d) => d.status === 'due' || d.status === 'overdue');
    return {
      tell: live.flatMap((d) => stagesDue(d, now).map((stage) => ({ duty: d, stage, to: stage === 'overdue' ? d.escalate : d.owner }))),
      approve: live.filter((d) => d.approvalRequired && !d.approved),
      act: live.filter((d) => !d.approvalRequired || d.approved),
    };
  }

  private async live(id: string): Promise<Duty> {
    const { duty } = await this.duty(id);
    if (duty.done) throw new TsutomeError(`duty ${id} is already met`);
    if (duty.status === 'withdrawn') throw new TsutomeError(`duty ${id} was withdrawn with its rule`);
    return duty;
  }

  /** Records that someone was told. Being told is a fact of its own: "nobody told me" does not hold after it. */
  async alerted(id: string, stage: Stage, to: string, via?: string): Promise<Entry> {
    const d = await this.live(id);
    if (stage !== 'due' && stage !== 'overdue') throw new TsutomeError('stage: due or overdue');
    if (d.alerted.includes(stage)) throw new TsutomeError(`duty ${id}: ${stage} was already recorded as told`);
    if (!isActor(to)) throw new TsutomeError('to: who was told');
    return this.append('duty.alerted', { duty: id, stage, to, rule: d.rule, ...(via ? { via: via.slice(0, 64) } : {}) });
  }

  /**
   * Records a person's approval. `plan` is what they were shown, in words or
   * as data; the chain keeps its digest, so that what is done can be held
   * against what was approved.
   */
  async approve(ids: string[], by: string, opts: { channel?: string; plan?: string; evidence?: string } = {}): Promise<string[]> {
    if (!isActor(by)) throw new TsutomeError('an approval names who approves');
    const out: string[] = [];
    for (const id of [...new Set(ids)]) {
      const d = await this.live(id);
      if (d.status === 'excepted') throw new TsutomeError(`duty ${id} is under an exception`);
      if (d.approved) continue;
      await this.append('duty.approved', { duty: id, by, rule: d.rule, ...(opts.channel ? { channel: opts.channel.slice(0, 64) } : {}), ...(opts.plan ? { plan: sha256(opts.plan) } : {}), ...(opts.evidence ? { evidence: opts.evidence.slice(0, 200) } : {}) });
      out.push(id);
    }
    return out;
  }

  /** Anyone, an agent included, may ask that a duty be set aside. The reason stays outside the chain; its digest goes in. */
  async requestException(id: string, by: string, reason: string): Promise<Entry> {
    await this.live(id);
    if (!isActor(by)) throw new TsutomeError('a request names who asks');
    if (!reason.trim()) throw new TsutomeError('a request gives a reason');
    return this.append('duty.exception_requested', { duty: id, by, reason: sha256(reason) });
  }

  /** A person sets a duty aside. It is no longer due, and is not counted as kept either. */
  async except(id: string, by: string, reason?: string): Promise<Entry> {
    const d = await this.live(id);
    if (!isActor(by)) throw new TsutomeError('an exception names who grants it');
    if (d.status === 'excepted') throw new TsutomeError(`duty ${id} is already under an exception`);
    return this.append('duty.excepted', { duty: id, by, rule: d.rule, ...(reason ? { reason: sha256(reason) } : {}) });
  }

  async endException(id: string, by: string): Promise<Entry> {
    const d = await this.live(id);
    if (d.status !== 'excepted') throw new TsutomeError(`duty ${id} is not under an exception`);
    if (!isActor(by)) throw new TsutomeError('ending an exception names who ends it');
    return this.append('duty.exception_ended', { duty: id, by });
  }

  /**
   * Notes that someone looked at what is due, at most once per `everyMs`.
   * An agent that has stopped looking shows as a silence in the chain.
   */
  async looked(by: string, everyMs = 3_600_000): Promise<void> {
    if (!isActor(by)) return;
    const last = [...(await this.entries())].reverse().find((e) => e.event === 'tsutome.looked' && e.meta.by === by);
    if (last && this.now().getTime() - Date.parse(last.at) < everyMs) return;
    await this.append('tsutome.looked', { by });
  }

  /** When each actor last looked, from the chain. */
  async lastLooked(): Promise<{ [by: string]: string }> {
    const out: { [by: string]: string } = {};
    for (const e of await this.entries()) if (e.event === 'tsutome.looked' && e.meta.by) out[e.meta.by] = e.at;
    return out;
  }

  async audit(): Promise<Finding[]> {
    return audit(await this.entries(), this.now());
  }
}

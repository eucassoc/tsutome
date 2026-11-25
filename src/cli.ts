#!/usr/bin/env node
// tsutome: duties that arise from rules.
//
//   tsutome check FILE...                      read rule files and say what is wrong, by line
//   tsutome adopt FILE --by NAME               put a rule in force, as the file stands
//   tsutome retire ID --by NAME                take a rule out of force
//   tsutome rules                              rule files next to what is in force
//   tsutome check-calendar FILE...             read calendar files and say what is wrong, by line
//   tsutome adopt-calendar FILE --by NAME      put a calendar of business days in force, as the file stands
//   tsutome calendars                          calendar files next to what is in force
//   tsutome record EVENT -m key=value...       record that something happened
//   tsutome agenda                             whom to tell, what waits for approval, what can be done
//   tsutome duties [--status S]                every duty and its state
//   tsutome duty ID                            one duty and its records
//   tsutome told ID --stage due|overdue --to NAME [--via CHANNEL]
//   tsutome approve ID... --by NAME [--plan FILE] [--evidence REF]
//   tsutome except ID --by NAME [--reason-file FILE]    set a duty aside
//   tsutome unexcept ID --by NAME
//   tsutome audit                              findings; exit 1 if there are any
//   tsutome verify                             check the chain; exit 1 if it does not hold
//   tsutome hmac REF                           the identifier to record in place of REF
//
// --chain FILE (TSUTOME_CHAIN, default tsutome.jsonl)   --rules DIR (TSUTOME_RULES, default rules)
// --calendars DIR (TSUTOME_CALENDARS, default calendars next to the rules)
// --name NAME (a new chain's name)   --json   --now TIME (for rehearsals)
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hmacId } from './chain.js';
import { dueText, type Duty } from './duties.js';
import { Tsutome } from './tsutome.js';
import { VERSION } from './version.js';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chain: { type: 'string' },
    rules: { type: 'string' },
    calendars: { type: 'string' },
    name: { type: 'string' },
    now: { type: 'string' },
    json: { type: 'boolean' },
    by: { type: 'string' },
    to: { type: 'string' },
    via: { type: 'string' },
    stage: { type: 'string' },
    status: { type: 'string' },
    plan: { type: 'string' },
    evidence: { type: 'string' },
    channel: { type: 'string' },
    'reason-file': { type: 'string' },
    meta: { type: 'string', short: 'm', multiple: true },
    hmac: { type: 'string', multiple: true },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

const env = process.env;
const [cmd, ...args] = positionals;
const out = (v: unknown, line: () => string) => console.log(o.json ? JSON.stringify(v, null, 1) : line());
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${cmd}: ${what}`);
  return v;
};
const pairs = (list: string[] | undefined, what: string): { [k: string]: string } => {
  const m: { [k: string]: string } = {};
  for (const p of list ?? []) {
    const i = p.indexOf('=');
    if (i < 1) throw new Error(`${what} ${JSON.stringify(p)}: write key=value`);
    m[p.slice(0, i)] = p.slice(i + 1);
  }
  return m;
};
const dutyLine = (d: Duty): string => `${d.id}  ${d.status.padEnd(9)}  due ${dueText(d)}  ${d.owner}  ${d.rule}: ${d.expect} for ${Object.entries(d.about).map(([k, v]) => `${k} ${v}`).join(', ')}${d.approvalRequired ? (d.approved ? `  approved by ${d.approved.by}` : '  needs approval') : ''}`;

async function main(): Promise<number> {
  if (o.version) return console.log(`tsutome ${VERSION}`), 0;
  if (o.help || !cmd) {
    const src = await readFile(new URL(import.meta.url), 'utf8').catch(() => '');
    console.log(src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n') || 'tsutome: see the README');
    return cmd ? 0 : 2;
  }
  const now = o.now ? new Date(o.now) : undefined;
  if (now && Number.isNaN(now.getTime())) throw new Error(`--now ${o.now}: not a time`);
  const t = new Tsutome({ chain: o.chain ?? env.TSUTOME_CHAIN ?? 'tsutome.jsonl', rules: o.rules ?? env.TSUTOME_RULES ?? 'rules', ...(o.calendars ?? env.TSUTOME_CALENDARS ? { calendars: (o.calendars ?? env.TSUTOME_CALENDARS) as string } : {}), ...(o.name ?? env.TSUTOME_NAME ? { name: (o.name ?? env.TSUTOME_NAME) as string } : {}), ...(now ? { now: () => now } : {}) });

  switch (cmd) {
    case 'check': {
      let bad = 0;
      for (const f of args.length ? args : [need(undefined, 'the rule files to check')]) {
        try {
          const r = await t.readRule(f);
          console.log(`${f}: ok  when ${r.terms.when}, ${r.terms.expect} within ${r.terms.within}${r.terms.calendar ? ` by calendar ${r.terms.calendar}` : ''}, owner ${r.terms.owner}`);
        } catch (e) {
          bad += 1;
          console.error((e as Error).message);
        }
      }
      return bad ? 1 : 0;
    }
    case 'adopt': {
      const r = await t.adopt(need(args[0], 'the rule file'), need(o.by, '--by NAME, who adopts it'));
      out(r, () => `adopted ${r.id} version ${r.version} (record ${r.seq}, sha256 ${r.digest.slice(0, 12)})`);
      return 0;
    }
    case 'retire':
      await t.retire(need(args[0], 'the rule id'), need(o.by, '--by NAME'));
      console.log(`retired ${args[0]}`);
      return 0;
    case 'rules': {
      const rs = await t.rules();
      out(rs, () => rs.map((r) => `${r.state.padEnd(8)}  ${r.id}${r.adopted ? `  version ${r.adopted.version}, adopted by ${r.adopted.adoptedBy} ${r.adopted.adoptedAt}` : ''}${r.error ? `  ${r.error}` : ''}`).join('\n') || 'no rules');
      return 0;
    }
    case 'check-calendar': {
      let bad = 0;
      for (const f of args.length ? args : [need(undefined, 'the calendar files to check')]) {
        try {
          const c = (await t.readCalendar(f)).terms;
          console.log(`${f}: ok  ${c.from} to ${c.until}, ${c.timezone}, closed on ${c.weekend.join(', ') || 'no day of the week'} and ${c.closed.length} other days`);
        } catch (e) {
          bad += 1;
          console.error((e as Error).message);
        }
      }
      return bad ? 1 : 0;
    }
    case 'adopt-calendar': {
      const c = await t.adoptCalendar(need(args[0], 'the calendar file'), need(o.by, '--by NAME, who adopts it'));
      out(c, () => `adopted calendar ${c.id} version ${c.version} (record ${c.seq}, sha256 ${c.digest.slice(0, 12)}), ${c.from} to ${c.until}`);
      return 0;
    }
    case 'calendars': {
      const cs = await t.calendars();
      out(cs, () => cs.map((c) => `${c.state.padEnd(8)}  ${c.id}${c.adopted ? `  version ${c.adopted.version}, ${c.adopted.from} to ${c.adopted.until} ${c.adopted.timezone}, adopted by ${c.adopted.adoptedBy} ${c.adopted.adoptedAt}` : ''}${c.error ? `  ${c.error}` : ''}`).join('\n') || 'no calendars');
      return 0;
    }
    case 'record': {
      const meta = pairs(o.meta, '-m');
      for (const [k, ref] of Object.entries(pairs(o.hmac, '--hmac'))) meta[k] = hmacId(need(env.TSUTOME_HMAC_KEY, 'TSUTOME_HMAC_KEY is not set'), ref);
      const e = await t.record(need(args[0], 'the event name'), meta, o.by);
      out(e, () => `recorded ${e.event} (record ${e.seq})`);
      return 0;
    }
    case 'agenda': {
      const a = await t.agenda();
      out(a, () =>
        [
          ...a.tell.map((x) => `tell ${x.to}: ${x.stage}  ${dutyLine(x.duty)}`),
          ...a.approve.map((d) => `approve    ${dutyLine(d)}`),
          ...a.act.map((d) => `act        ${dutyLine(d)}`),
        ].join('\n') || 'nothing to do now',
      );
      return 0;
    }
    case 'duties': {
      const ds = (await t.duties()).filter((d) => !o.status || d.status === o.status);
      out(ds, () => ds.map(dutyLine).join('\n') || 'no duties');
      return 0;
    }
    case 'duty': {
      const d = await t.duty(need(args[0], 'the duty id'));
      out(d, () => [dutyLine(d.duty), ...d.records.map((e) => `  #${e.seq} ${e.at} ${e.event} ${Object.entries(e.meta).map(([k, v]) => `${k}=${v.length > 24 ? v.slice(0, 12) + '…' : v}`).join(' ')}`)].join('\n'));
      return 0;
    }
    case 'told': {
      const e = await t.alerted(need(args[0], 'the duty id'), need(o.stage, '--stage due or overdue') as 'due' | 'overdue', need(o.to, '--to NAME'), o.via);
      console.log(`recorded (record ${e.seq})`);
      return 0;
    }
    case 'approve': {
      const plan = o.plan ? await readFile(o.plan, 'utf8') : undefined;
      const ids = await t.approve(args.length ? args : [need(undefined, 'the duty ids')], need(o.by, '--by NAME, who approves'), { channel: o.channel ?? 'cli', ...(plan ? { plan } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) });
      out({ approved: ids }, () => (ids.length ? `approved ${ids.join(', ')}` : 'already approved'));
      return 0;
    }
    case 'except': {
      const reason = o['reason-file'] ? await readFile(o['reason-file'], 'utf8') : undefined;
      const e = await t.except(need(args[0], 'the duty id'), need(o.by, '--by NAME, who grants it'), reason);
      console.log(`set aside (record ${e.seq})`);
      return 0;
    }
    case 'unexcept': {
      const e = await t.endException(need(args[0], 'the duty id'), need(o.by, '--by NAME'));
      console.log(`exception ended (record ${e.seq})`);
      return 0;
    }
    case 'audit': {
      const fs = await t.audit();
      out(fs, () => fs.map((f) => `line ${f.seq + 1}: ${f.kind}: ${f.message}`).join('\n') || 'no findings');
      return fs.length ? 1 : 0;
    }
    case 'verify': {
      const v = await t.verify();
      out({ count: v.entries.length, head: v.head, problems: v.problems }, () => (v.problems.length ? v.problems.map((p) => `line ${p.line}: ${p.reason}`).join('\n') : `${v.entries.length} records hold together${v.head ? `; head sha256:${v.head}` : ''}`));
      return v.problems.length ? 1 : 0;
    }
    case 'hmac':
      console.log(hmacId(need(env.TSUTOME_HMAC_KEY, 'TSUTOME_HMAC_KEY is not set'), need(args[0], 'what to derive the identifier from')));
      return 0;
    default:
      throw new Error(`${cmd}: not a command; see tsutome --help`);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(`tsutome: ${e.message}`);
    process.exitCode = 2;
  },
);

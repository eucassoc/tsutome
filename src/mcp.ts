#!/usr/bin/env node
// The MCP server an agent works through: it writes rule files as drafts,
// looks at what is due, records what it did and whom it told, and asks for
// exceptions. What it cannot do is decide: putting a rule in force and
// granting an exception are a person's, done with the `tsutome` command.
//
//   TSUTOME_CHAIN=tsutome.jsonl TSUTOME_RULES=rules tsutome-mcp
//
//   TSUTOME_ACTOR      the name the agent's records carry (default: agent)
//   TSUTOME_APPROVER   the person on whose behalf tsutome_approve records an
//                      approval; the client's permission prompt is then that
//                      person's decision. Without it the tool refuses.
//   TSUTOME_HMAC_KEY   the key for identifiers given under `hmac`
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hmacId, sha256 } from './chain.js';
import { Tsutome, type Options } from './tsutome.js';
import { VERSION } from './version.js';

export interface McpOptions extends Options {
  actor?: string;
  approver?: string;
  hmacKey?: string;
}

export function tsutomeServer(opts: McpOptions): McpServer {
  const t = new Tsutome(opts);
  const actor = opts.actor ?? 'agent';
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 1) }] });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return text(await fn());
    } catch (e) {
      return { ...text({ error: (e as Error).message }), isError: true };
    }
  };
  const read = { readOnlyHint: true };
  const write = { readOnlyHint: false, destructiveHint: false };
  const server = new McpServer({ name: 'tsutome', version: VERSION });

  server.registerTool(
    'tsutome_agenda',
    {
      title: 'What there is to do now',
      description: 'The duties that have come up: whom to tell (`tell`), what waits for a person\'s approval (`approve`), and what can be done (`act`). Call this on a schedule. Each call is noted in the chain, so that an agent that stops looking shows.',
      inputSchema: {},
      annotations: write,
    },
    () =>
      run(async () => {
        await t.looked(actor);
        return t.agenda();
      }),
  );
  server.registerTool(
    'tsutome_duties',
    { title: 'List duties', description: 'Every duty the rules have given rise to, with its deadline, owner and state: waiting, due, overdue, done, done_late, excepted or withdrawn.', inputSchema: { status: z.enum(['waiting', 'due', 'overdue', 'done', 'done_late', 'excepted', 'withdrawn']).optional() }, annotations: read },
    ({ status }) => run(async () => (await t.duties()).filter((d) => !status || d.status === status)),
  );
  server.registerTool('tsutome_duty', { title: 'One duty', description: 'A duty and the records that concern it.', inputSchema: { duty: z.string() }, annotations: read }, ({ duty }) => run(() => t.duty(duty)));
  server.registerTool(
    'tsutome_rules',
    { title: 'List rules', description: 'Every rule file next to what is in force: adopted, changed (the file differs from what was adopted), draft, invalid, missing or retired.', inputSchema: {}, annotations: read },
    () => run(() => t.rules()),
  );
  server.registerTool(
    'tsutome_draft_rule',
    {
      title: 'Write a rule file',
      description:
        'Writes a rule as a file in the rules directory: when `when` happens to a thing, `expect` must follow within `within`. It is a draft and changes nothing until a person adopts it with `tsutome adopt FILE --by NAME`. `text` is the policy in its own words. `per` names the meta keys that identify the thing (default: item). `notice` is how long before the deadline the duty comes up (default: from the start).',
      inputSchema: {
        id: z.string(),
        title: z.string(),
        source: z.string().optional().describe('The clause of the policy, law or contract the rule comes from'),
        when: z.string().describe('The event that starts the clock, e.g. data.answered'),
        expect: z.string().describe('The event that must follow, e.g. data.deleted'),
        within: z.string().describe('The deadline: 30d, 12h, 45m'),
        notice: z.string().optional(),
        owner: z.string().describe('The role that must act'),
        escalate: z.string().optional().describe('The role told when the deadline has passed (default: the owner)'),
        per: z.array(z.string()).optional(),
        approval: z.enum(['required', 'none']).optional().describe('required: a person approves before the expected event'),
        where: z.record(z.string(), z.string()).optional().describe('Only triggers whose meta equal these'),
        text: z.string().describe('The words of the policy'),
      },
      annotations: write,
    },
    (a) =>
      run(async () => {
        const file = await t.draft({ id: a.id, title: a.title, ...(a.source ? { source: a.source } : {}), when: a.when, expect: a.expect, within: a.within, notice: a.notice ?? a.within, owner: a.owner, escalate: a.escalate ?? a.owner, per: a.per ?? ['item'], approval: a.approval ?? 'none', where: a.where ?? {} }, a.text);
        return { file, state: 'draft', next: `a person reviews the file and runs: tsutome adopt ${file} --by NAME` };
      }),
  );
  server.registerTool(
    'tsutome_record',
    {
      title: 'Record what happened',
      description: 'Appends an event to the chain: a trigger a rule waits on, or the event that meets a duty. `meta` names what it is about under the keys the rules read (e.g. item). Never put personal data or contents in it; for an identifier that could be guessed, give it under `hmac` instead and its HMAC is recorded.',
      inputSchema: { event: z.string(), meta: z.record(z.string(), z.string()).optional(), hmac: z.record(z.string(), z.string()).optional(), plan: z.string().optional().describe('What was done, as shown for approval; its digest is recorded') },
      annotations: write,
    },
    ({ event, meta, hmac, plan }) =>
      run(async () => {
        const m: { [k: string]: string } = { ...(meta ?? {}) };
        for (const [k, ref] of Object.entries(hmac ?? {})) {
          if (!opts.hmacKey) throw new Error('hmac: this server holds no key; set TSUTOME_HMAC_KEY');
          m[k] = hmacId(opts.hmacKey, ref);
        }
        if (plan) m.plan = sha256(plan);
        const e = await t.record(event, m, actor);
        return { seq: e.seq, event: e.event, meta: e.meta };
      }),
  );
  server.registerTool(
    'tsutome_told',
    { title: 'Record that someone was told', description: 'After telling the owner that a duty has come up (stage due), or the escalation contact that it is overdue, record it. Telling is a fact of its own.', inputSchema: { duty: z.string(), stage: z.enum(['due', 'overdue']), to: z.string(), via: z.string().optional().describe('The channel, e.g. slack') }, annotations: write },
    ({ duty, stage, to, via }) => run(async () => ({ seq: (await t.alerted(duty, stage, to, via)).seq })),
  );
  server.registerTool(
    'tsutome_approve',
    {
      title: 'Record a person\'s approval',
      description: 'Records that the approver agreed to the duties being carried out. A person\'s decision: show them `plan`, exactly what will be done, first. Refused unless this server was started for a named approver. `evidence` points at the approval where it was given (a message link, a ticket).',
      inputSchema: { duties: z.array(z.string()).min(1), plan: z.string().optional(), evidence: z.string().optional() },
      annotations: write,
    },
    ({ duties, plan, evidence }) =>
      run(async () => {
        if (!opts.approver) throw new Error('this server approves for no one; a person runs `tsutome approve DUTY --by NAME`, or the server is started with TSUTOME_APPROVER');
        return { approved: await t.approve(duties, opts.approver, { channel: 'mcp', ...(plan ? { plan } : {}), ...(evidence ? { evidence } : {}) }) };
      }),
  );
  server.registerTool(
    'tsutome_request_exception',
    { title: 'Ask that a duty be set aside', description: 'Asks that a duty not be carried out, with a reason. Only a request: a person grants it with `tsutome except DUTY --by NAME`. The reason is not put in the chain; its digest is.', inputSchema: { duty: z.string(), reason: z.string().min(1) }, annotations: write },
    ({ duty, reason }) => run(async () => ({ seq: (await t.requestException(duty, actor, reason)).seq, next: `a person decides: tsutome except ${duty} --by NAME` })),
  );
  server.registerTool('tsutome_audit', { title: 'Findings', description: 'What an auditor would point at: overdue, done late, done without the approval a rule requires, done differently from the approved plan, nobody told. Each with the record where it shows.', inputSchema: {}, annotations: read }, () => run(() => t.audit()));
  return server;
}

const invoked = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1] as string) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) {
  const env = process.env;
  const server = tsutomeServer({
    chain: env.TSUTOME_CHAIN ?? 'tsutome.jsonl',
    rules: env.TSUTOME_RULES ?? 'rules',
    ...(env.TSUTOME_NAME ? { name: env.TSUTOME_NAME } : {}),
    ...(env.TSUTOME_ACTOR ? { actor: env.TSUTOME_ACTOR } : {}),
    ...(env.TSUTOME_APPROVER ? { approver: env.TSUTOME_APPROVER } : {}),
    ...(env.TSUTOME_HMAC_KEY ? { hmacKey: env.TSUTOME_HMAC_KEY } : {}),
  });
  await server.connect(new StdioServerTransport());
}

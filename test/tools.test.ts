import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { hmacId } from '../src/chain.js';
import { tsutomeServer } from '../src/mcp.js';
import { VERSION } from '../src/version.js';
import { DELETE_AFTER_ANSWER, workspace } from './helpers.js';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');

test('the version is the one in package.json', async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test('rule files next to what is in force: draft, adopted, changed, missing, retired', async () => {
  const w = await workspace();
  const path = await w.t.draft({ id: 'answer-in-time', title: 'Answer within two days', when: 'inquiry.received', expect: 'inquiry.answered', within: '2d', notice: '2d', owner: 'support', escalate: 'support', per: ['item'], approval: 'none', where: {} }, 'Inquiries are answered within two working days.');
  assert.equal(path, join(w.opts.rules, 'answer-in-time.md'));
  assert.match(await readFile(path, 'utf8'), /^---\nid: answer-in-time\ntitle: Answer within two days\nwhen: inquiry\.received\n/);
  const other = await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER);
  const states = async () => (await w.t.rules()).map((r) => [r.id, r.state]);
  assert.deepEqual(await states(), [['answer-in-time', 'draft'], ['delete-after-answer', 'draft']]);
  await w.t.adopt(path, 'lead');
  await w.t.adopt(other, 'legal');
  assert.deepEqual(await states(), [['answer-in-time', 'adopted'], ['delete-after-answer', 'adopted']]);
  // A draft written over an adopted rule's file changes nothing until adopted.
  await w.t.draft({ id: 'answer-in-time', title: 'Answer within a day', when: 'inquiry.received', expect: 'inquiry.answered', within: '1d', notice: '1d', owner: 'support', escalate: 'support', per: ['item'], approval: 'none', where: {} }, 'Within one working day.');
  await rm(other);
  assert.deepEqual(await states(), [['answer-in-time', 'changed'], ['delete-after-answer', 'missing']]);
  await w.t.record('inquiry.received', { item: 'q1' });
  assert.equal((await w.t.duties())[0]?.dueAt, '2026-04-03T00:00:00Z');
  await w.t.retire('delete-after-answer', 'legal');
  assert.deepEqual(await states(), [['answer-in-time', 'changed'], ['delete-after-answer', 'retired']]);
  await assert.rejects(w.t.draft({ id: 'x', title: 'x', when: 'a.b', expect: 'a.b', within: '1d', notice: '1d', owner: 'o', escalate: 'o', per: ['item'], approval: 'none', where: {} }, ''), /cannot be the one that starts the clock/);
});

test('an agent that stops looking shows: each look is noted, at most once an hour', async () => {
  const w = await workspace();
  await w.t.looked('agent');
  await w.t.looked('agent');
  w.clock.hours(2);
  await w.t.looked('agent');
  await w.t.looked('other');
  assert.deepEqual((await w.t.verify()).entries.map((e) => [e.event, e.meta.by, e.at]), [
    ['tsutome.looked', 'agent', '2026-04-01T00:00:00Z'],
    ['tsutome.looked', 'agent', '2026-04-01T02:00:00Z'],
    ['tsutome.looked', 'other', '2026-04-01T02:00:00Z'],
  ]);
  assert.deepEqual(await w.t.lastLooked(), { agent: '2026-04-01T02:00:00Z', other: '2026-04-01T02:00:00Z' });
});

test('the command line: a rule adopted, a trigger recorded, the duty approved and met, and the audit clean', async () => {
  const w = await workspace();
  const file = await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER);
  const env = { ...process.env, TSUTOME_CHAIN: w.opts.chain, TSUTOME_RULES: w.opts.rules, TSUTOME_HMAC_KEY: 'k' };
  const t = (args: string[], now = '2026-04-01T00:00:00Z') => run('node', [CLI, ...args, '--now', now, '--name', 'cli.test'], { env });
  const fails = async (args: string[], now?: string) => {
    try {
      await t(args, now);
    } catch (e) {
      return e as { code: number; stdout: string; stderr: string };
    }
    throw new Error(`${args.join(' ')} did not fail`);
  };

  assert.match((await t(['check', file])).stdout, /ok {2}when data\.answered, data\.deleted within 30d, owner support/);
  await writeFile(join(w.opts.rules, 'bad.md'), DELETE_AFTER_ANSWER.replace('within: 30d', 'within: soon'));
  const bad = await fails(['check', join(w.opts.rules, 'bad.md')]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /bad\.md:7: within: "soon" is not a duration/);
  await rm(join(w.opts.rules, 'bad.md'));

  assert.match((await fails(['adopt', file])).stderr, /tsutome: adopt: --by NAME, who adopts it/);
  assert.match((await t(['adopt', file, '--by', 'legal'])).stdout, /adopted delete-after-answer version 1 \(record 0, sha256 [0-9a-f]{12}\)/);
  assert.match((await t(['rules'])).stdout, /adopted {3}delete-after-answer {2}version 1, adopted by legal/);
  // The item is recorded as an HMAC, not as the receipt number.
  await t(['record', 'data.answered', '--hmac', 'item=Q-0001', '-m', 'form=contact', '--by', 'support']);
  const item = hmacId('k', 'Q-0001');
  assert.equal((await t(['hmac', 'Q-0001'])).stdout.trim(), item);
  assert.ok(!(await readFile(w.opts.chain, 'utf8')).includes('Q-0001'));
  assert.equal((await t(['agenda'])).stdout.trim(), 'nothing to do now');

  const later = '2026-04-25T00:00:00Z';
  const agenda = (await t(['agenda'], later)).stdout;
  assert.match(agenda, /^tell support: due /m);
  assert.match(agenda, new RegExp(`^approve +[0-9a-f]{12} +due +due 2026-05-01T00:00:00Z +support +delete-after-answer: data\\.deleted for item ${item} +needs approval$`, 'm'));
  const duties = JSON.parse((await t(['duties', '--json'], later)).stdout) as { id: string; status: string }[];
  const id = duties[0]?.id as string;
  assert.equal(duties[0]?.status, 'due');

  await t(['told', id, '--stage', 'due', '--to', 'support', '--via', 'mail'], later);
  await writeFile(join(w.dir, 'plan.txt'), 'delete Q-0001 at the site');
  assert.match((await t(['approve', id, '--by', 'support', '--plan', join(w.dir, 'plan.txt')], later)).stdout, new RegExp(`approved ${id}`));
  await t(['record', 'data.deleted', '-m', `item=${item}`, '--by', 'agent'], later);
  assert.match((await t(['duty', id], later)).stdout, /done .*approved by support\n {2}#1 .* data\.answered .*\n {2}#2 .* duty\.alerted .*\n {2}#3 .* duty\.approved .*\n {2}#4 .* data\.deleted/);
  assert.equal((await t(['audit'], later)).stdout.trim(), 'no findings');
  assert.match((await t(['verify'])).stdout, /5 records hold together; head sha256:[0-9a-f]{64}/);

  // Another one, left alone: the audit names the record and exits 1.
  await t(['record', 'data.answered', '-m', 'item=x2', '-m', 'form=contact'], later);
  const audit = await fails(['audit'], '2026-06-30T00:00:00Z');
  assert.equal(audit.code, 1);
  assert.match(audit.stdout, /^line 6: overdue: delete-after-answer: data\.deleted for item x2 was due 2026-05-25T00:00:00Z and has not happened$/m);
  assert.match((await fails(['frobnicate'])).stderr, /not a command/);
  assert.match((await t(['--version'])).stdout, new RegExp(`^tsutome ${VERSION.replace(/\./g, '\\.')}$`, 'm'));
});

test('an agent over MCP: it drafts a rule, a person adopts it; it works the agenda, and cannot decide in a person\'s place', async () => {
  const w = await workspace();
  const connect = async (extra: object = {}) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await tsutomeServer({ ...w.opts, hmacKey: 'k', ...extra }).connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const call = async (name: string, args: object = {}) => {
      const r = (await client.callTool({ name, arguments: args as { [k: string]: unknown } })) as { content: { text: string }[]; isError?: boolean };
      return { data: JSON.parse(r.content[0]?.text ?? 'null'), isError: Boolean(r.isError) };
    };
    return { client, call };
  };
  const agent = await connect();
  const tools = (await agent.client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['tsutome_agenda', 'tsutome_approve', 'tsutome_audit', 'tsutome_draft_rule', 'tsutome_duties', 'tsutome_duty', 'tsutome_record', 'tsutome_request_exception', 'tsutome_rules', 'tsutome_told']);
  // Nothing an agent can call puts a rule in force or grants an exception.
  assert.ok(!tools.some((t) => /adopt|retire|except$/.test(t.name)));

  const drafted = await agent.call('tsutome_draft_rule', { id: 'delete-after-answer', title: 'Delete inquiries 30 days after they are answered', source: 'Personal data policy, article 12.1', when: 'data.answered', expect: 'data.deleted', within: '30d', notice: '7d', owner: 'support', escalate: 'legal', approval: 'required', text: 'Inquiries are deleted within 30 days of the day they are answered.' });
  assert.equal(drafted.data.state, 'draft');
  assert.match(drafted.data.next, /tsutome adopt .*delete-after-answer\.md --by NAME/);
  assert.match((await agent.call('tsutome_draft_rule', { id: 'x', title: 'x', when: 'a.b', expect: 'c.d', within: 'soon', owner: 'o', text: '' })).data.error, /not a duration/);
  assert.deepEqual((await agent.call('tsutome_rules')).data.map((r: { state: string }) => r.state), ['draft']);

  await agent.call('tsutome_record', { event: 'data.answered', hmac: { item: 'Q-1' } });
  assert.deepEqual((await agent.call('tsutome_duties')).data, []);
  await w.t.adopt(drafted.data.file, 'legal'); // the person's part
  assert.match((await agent.call('tsutome_record', { event: 'duty.excepted', meta: { duty: 'x' } })).data.error, /recorded by their own operations/);

  w.clock.days(24);
  const agenda = (await agent.call('tsutome_agenda')).data;
  assert.deepEqual([agenda.tell.length, agenda.approve.length, agenda.act.length], [1, 1, 0]);
  const id = agenda.approve[0].id as string;
  assert.equal(agenda.approve[0].about.item, hmacId('k', 'Q-1'));
  await agent.call('tsutome_told', { duty: id, stage: 'due', to: 'support', via: 'slack' });
  assert.match((await agent.call('tsutome_approve', { duties: [id] })).data.error, /approves for no one/);
  // Not approved, the agent has nothing to act on.
  assert.deepEqual((await agent.call('tsutome_agenda')).data.act, []);

  const withPerson = await connect({ approver: 'support' });
  assert.deepEqual((await withPerson.call('tsutome_approve', { duties: [id], plan: 'delete Q-1 at the site', evidence: 'slack:C1/p9' })).data.approved, [id]);
  assert.deepEqual((await agent.call('tsutome_agenda')).data.act.map((d: { id: string }) => d.id), [id]);
  await agent.call('tsutome_record', { event: 'data.deleted', hmac: { item: 'Q-1' }, plan: 'delete Q-1 at the site' });
  const d = (await agent.call('tsutome_duty', { duty: id })).data;
  assert.equal(d.duty.status, 'done');
  assert.deepEqual(d.records.map((e: { event: string; meta: { by?: string } }) => [e.event, e.meta.by]), [['data.answered', 'agent'], ['duty.alerted', undefined], ['duty.approved', 'support'], ['data.deleted', 'agent']]);
  assert.deepEqual((await agent.call('tsutome_audit')).data, []);

  // Each look at the agenda left its mark, once.
  assert.deepEqual(Object.keys(await w.t.lastLooked()), ['agent']);
  await agent.call('tsutome_record', { event: 'data.answered', meta: { item: 'q2' } });
  const q2 = (await agent.call('tsutome_duties', { status: 'waiting' })).data[0].id as string;
  assert.match((await agent.call('tsutome_request_exception', { duty: q2, reason: 'held for a dispute' })).data.next, /a person decides: tsutome except/);
  assert.equal((await w.t.duty(q2)).duty.status, 'waiting');
  assert.ok(!(await readFile(w.opts.chain, 'utf8')).includes('dispute'));
});

test('deedlog verifies a chain tsutome wrote (set DLOG to the dlog binary to run this)', { skip: !process.env.DLOG }, async () => {
  const w = await workspace();
  await w.t.adopt(await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER), 'legal');
  await w.t.record('data.answered', { item: 'q1', form: 'contact' }, 'support');
  const { stdout } = await run(process.env.DLOG as string, ['verify', w.opts.chain]);
  const v = JSON.parse(stdout) as { chain: string; count: number; head: string };
  assert.deepEqual([v.chain, v.count, v.head], ['example.test/duties', 2, 'sha256:' + (await w.t.verify()).head]);
});

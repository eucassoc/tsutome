import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ChainError } from '../src/chain.js';
import { TsutomeError } from '../src/tsutome.js';
import { DELETE_AFTER_ANSWER, PATCH, workspace } from './helpers.js';

test('a duty arises at its trigger, comes up at its notice, goes overdue, and is met by the expected event', async () => {
  const w = await workspace();
  const file = await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER);
  // A file alone is a draft: nothing arises from it.
  await w.t.record('data.answered', { item: 'early', form: 'contact' });
  assert.deepEqual(await w.t.duties(), []);
  assert.deepEqual((await w.t.rules()).map((r) => [r.id, r.state]), [['delete-after-answer', 'draft']]);

  const rule = await w.t.adopt(file, 'legal');
  assert.deepEqual([rule.version, rule.adoptedBy, rule.within, rule.where], [1, 'legal', '30d', { form: 'contact' }]);
  await assert.rejects(w.t.adopt(file, 'legal'), /already in force/);
  w.clock.days(1);
  await w.t.record('data.answered', { item: 'q1', form: 'contact' }, 'support');
  await w.t.record('data.answered', { item: 'q2', form: 'other' }); // another form: the rule does not cover it
  await w.t.record('data.answered', { form: 'contact' }); // names nothing: no duty can be told from it

  let ds = await w.t.duties();
  // What was already there when the rule was adopted comes under it, from the adoption on.
  assert.deepEqual(ds.map((d) => [d.about.item, d.status, d.startsAt, d.dueAt]), [
    ['early', 'waiting', '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z'],
    ['q1', 'waiting', '2026-04-02T00:00:00Z', '2026-05-02T00:00:00Z'],
  ]);
  const q1 = ds[1]?.id as string;
  assert.deepEqual(await w.t.agenda(), { tell: [], approve: [], act: [] });

  w.clock.days(24); // 7 days before q1's deadline
  let a = await w.t.agenda();
  assert.deepEqual(a.tell.map((x) => [x.duty.about.item, x.stage, x.to]), [['early', 'due', 'support'], ['q1', 'due', 'support']]);
  assert.deepEqual(a.approve.map((d) => d.about.item), ['early', 'q1']);
  assert.deepEqual(a.act, []);
  await w.t.alerted(q1, 'due', 'support', 'slack');
  await assert.rejects(w.t.alerted(q1, 'due', 'support'), /already recorded as told/);

  w.clock.days(8);
  a = await w.t.agenda();
  assert.deepEqual(a.tell.filter((x) => x.duty.id === q1).map((x) => [x.stage, x.to]), [['overdue', 'legal']]);
  assert.equal((await w.t.duty(q1)).duty.status, 'overdue');

  assert.deepEqual(await w.t.approve([q1], 'support', { plan: 'delete q1 at the site', evidence: 'slack:C1/p123' }), [q1]);
  assert.deepEqual((await w.t.agenda()).act.map((d) => d.id), [q1]);
  await w.t.record('data.deleted', { item: 'q1', form: 'contact' }, 'agent');
  const { duty, records } = await w.t.duty(q1);
  assert.equal(duty.status, 'done_late');
  assert.equal(duty.approved?.by, 'support');
  assert.deepEqual(records.map((e) => e.event), ['data.answered', 'duty.alerted', 'duty.approved', 'data.deleted']);
  await assert.rejects(w.t.approve([q1], 'support'), /already met/);

  const findings = await w.t.audit();
  assert.deepEqual(findings.map((f) => [f.kind, f.seq]), [['overdue', 0], ['not_told', 0], ['not_told', 0], ['no_key', 4], ['late', 7]]);
  assert.match(findings[0]?.message ?? '', /data\.deleted for item early was due 2026-05-01T00:00:00Z and has not happened/);
  assert.match(findings[3]?.message ?? '', /names no item/);
});

test('what a rule requires is held against what was done: approval, and the plan that was approved', async () => {
  const w = await workspace();
  await w.t.adopt(await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER), 'legal');
  for (const item of ['a', 'b', 'c']) await w.t.record('data.answered', { item, form: 'contact' });
  const [a, b, c] = (await w.t.duties()).map((d) => d.id) as [string, string, string];

  // a: done with nobody's approval. b: approved, then something else was done. c: as approved.
  await w.t.record('data.deleted', { item: 'a' });
  await w.t.approve([b, c], 'support', { plan: 'delete the row' });
  await w.t.record('data.deleted', { item: 'b', plan: 'f'.repeat(64) });
  const { sha256 } = await import('../src/chain.js');
  await w.t.record('data.deleted', { item: 'c', plan: sha256('delete the row') });

  const fs = await w.t.audit();
  assert.deepEqual(fs.map((f) => [f.kind, f.duty]), [['unapproved', a], ['plan_mismatch', b]]);
  assert.match(fs[0]?.message ?? '', /done without the approval the rule requires/);
  assert.deepEqual((await w.t.duties()).map((d) => d.status), ['done', 'done', 'done']);
});

test('an exception is asked for by anyone and granted by a person; a retired rule withdraws what it had started', async () => {
  const w = await workspace();
  await w.t.adopt(await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER), 'legal');
  await w.t.record('data.answered', { item: 'a', form: 'contact' });
  await w.t.record('data.answered', { item: 'b', form: 'contact' });
  const [a, b] = (await w.t.duties()).map((d) => d.id) as [string, string];

  await w.t.requestException(a, 'agent', 'held for a dispute');
  assert.equal((await w.t.duty(a)).duty.status, 'waiting');
  await w.t.except(a, 'legal', 'held for a dispute');
  w.clock.days(40);
  assert.deepEqual((await w.t.duties()).map((d) => d.status), ['excepted', 'overdue']);
  await assert.rejects(w.t.approve([a], 'support'), /under an exception/);
  // The reason is not in the chain; its digest is.
  const text = await readFile(w.opts.chain, 'utf8');
  assert.ok(!text.includes('dispute'));
  await w.t.endException(a, 'legal');
  assert.equal((await w.t.duty(a)).duty.status, 'overdue');

  await w.t.retire('delete-after-answer', 'legal');
  assert.deepEqual((await w.t.duties()).map((d) => d.status), ['withdrawn', 'withdrawn']);
  await w.t.record('data.answered', { item: 'c', form: 'contact' });
  assert.equal((await w.t.duties()).length, 2);
  await assert.rejects(w.t.approve([b], 'support'), /withdrawn with its rule/);
  await assert.rejects(w.t.retire('delete-after-answer', 'legal'), /no rule/);
  assert.deepEqual(await w.t.audit(), []);
});

test('a changed rule waits for adoption; what was under way keeps the version it started under', async () => {
  const w = await workspace();
  const file = await w.rule('delete-after-answer.md', DELETE_AFTER_ANSWER);
  await w.t.adopt(file, 'legal');
  await w.t.record('data.answered', { item: 'a', form: 'contact' });
  await writeFile(file, DELETE_AFTER_ANSWER.replace('within: 30d', 'within: 90d'));
  assert.deepEqual((await w.t.rules()).map((r) => [r.state, r.adopted?.within]), [['changed', '30d']]);
  await w.t.record('data.answered', { item: 'b', form: 'contact' });
  w.clock.days(1);
  const v2 = await w.t.adopt(file, 'legal');
  assert.equal(v2.version, 2);
  await w.t.record('data.answered', { item: 'c', form: 'contact' });
  assert.deepEqual((await w.t.duties()).map((d) => [d.about.item, d.version, d.dueAt]), [
    ['a', 1, '2026-05-01T00:00:00Z'],
    ['b', 1, '2026-05-01T00:00:00Z'],
    ['c', 2, '2026-07-01T00:00:00Z'],
  ]);
  await writeFile(file, 'not a rule');
  assert.deepEqual((await w.t.rules()).map((r) => [r.state, r.error]), [['invalid', 'line 1: a rule file begins with a line of ---']]);
  await assert.rejects(w.t.adopt(file, 'legal'), /delete-after-answer\.md:1: a rule file begins/);
});

test('the same core in another field: a security fix due on every device an advisory applies to', async () => {
  const w = await workspace();
  await w.t.adopt(await w.rule('patch-critical.md', PATCH), 'security');
  for (const device of ['gw-01', 'gw-02']) await w.t.record('advisory.applies', { device, advisory: 'A-7' });
  await w.t.record('advisory.applies', { device: 'gw-01', advisory: 'A-9' });
  let ds = await w.t.duties();
  assert.deepEqual(ds.map((d) => [d.about, d.status]), [
    [{ device: 'gw-01', advisory: 'A-7' }, 'due'],
    [{ device: 'gw-02', advisory: 'A-7' }, 'due'],
    [{ device: 'gw-01', advisory: 'A-9' }, 'due'],
  ]);
  assert.equal(new Set(ds.map((d) => d.id)).size, 3);

  await w.t.approve([ds[0]?.id as string], 'fleet', { plan: 'firmware 2.4.1 to gw-01' });
  // The update of one device for one advisory meets that duty and no other.
  await w.t.record('firmware.updated', { device: 'gw-01', advisory: 'A-7', version: '2.4.1' }, 'agent');
  w.clock.days(31);
  ds = await w.t.duties();
  assert.deepEqual(ds.map((d) => d.status), ['done', 'overdue', 'overdue']);
  assert.deepEqual((await w.t.agenda()).tell.map((x) => [x.duty.about.device, x.duty.about.advisory, x.stage, x.to]), [
    ['gw-02', 'A-7', 'due', 'fleet'],
    ['gw-02', 'A-7', 'overdue', 'security'],
    ['gw-01', 'A-9', 'due', 'fleet'],
    ['gw-01', 'A-9', 'overdue', 'security'],
  ]);
});

test('the chain: several writers at once keep it whole; a changed line is named and stops everything', async () => {
  const w = await workspace();
  await Promise.all(Array.from({ length: 25 }, (_, i) => w.t.record('thing.happened', { item: `i${i}` })));
  const v = await w.t.verify();
  assert.equal(v.entries.length, 25);
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.entries.map((e) => e.seq), Array.from({ length: 25 }, (_, i) => i));

  const lines = (await readFile(w.opts.chain, 'utf8')).split('\n').filter(Boolean);
  const first = JSON.parse(lines[0] as string);
  assert.deepEqual([first.spec, first.chain, first.seq, first.source.type], ['deedlog/v0.1', 'example.test/duties', 0, 'tsutome']);
  lines[3] = (lines[3] as string).replace('"item":"i', '"item":"x');
  await writeFile(w.opts.chain, lines.join('\n') + '\n');
  assert.deepEqual((await w.t.verify()).problems.map((p) => p.line), [5]);
  await assert.rejects(w.t.duties(), (e: ChainError) => e instanceof ChainError && /line 5: prev does not match/.test(e.message));
  await assert.rejects(w.t.record('thing.happened', { item: 'late' }), /line 5/);
});

test('what may be recorded: event names, meta keys, and nothing of tsutome\'s own', async () => {
  const w = await workspace();
  const refuse = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => e instanceof TsutomeError && re.test(e.message));
  await refuse(w.t.record('duty.approved', { duty: 'x' }), /recorded by their own operations/);
  await refuse(w.t.record('rule.adopted', { rule: 'x' }), /recorded by their own operations/);
  await refuse(w.t.record('Deleted!', {}), /not an event name/);
  await refuse(w.t.record('data.deleted', { 'Item Id': 'x' }), /not a meta key/);
  await refuse(w.t.record('data.deleted', { by: 'x' }), /not a meta key/);
  await refuse(w.t.record('data.deleted', { item: 'two\nlines' }), /one line/);
  await refuse(w.t.record('data.deleted', { item: 'x' }, 'a person with spaces'), /by:/);
  await refuse(w.t.adopt(await w.rule('patch-critical.md', PATCH), ''), /names who adopts/);
  assert.equal((await w.t.verify()).entries.length, 0);
});

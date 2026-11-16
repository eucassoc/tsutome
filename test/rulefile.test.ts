import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duration, formatRule, parseRule, RuleError } from '../src/rulefile.js';
import { DELETE_AFTER_ANSWER, PATCH } from './helpers.js';

test('a rule file reads into terms and the words of the policy, and writes back the same', () => {
  const r = parseRule(DELETE_AFTER_ANSWER, 'delete-after-answer.md');
  assert.deepEqual(r.terms, { id: 'delete-after-answer', title: 'Delete inquiries 30 days after they are answered', source: 'Personal data policy, article 12.1', when: 'data.answered', expect: 'data.deleted', within: '30d', notice: '7d', owner: 'support', escalate: 'legal', per: ['item'], approval: 'required', where: { form: 'contact' } });
  assert.equal(r.text, 'Inquiries are deleted within 30 days of the day they are answered.');
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  const again = parseRule(formatRule(r.terms, r.text));
  assert.deepEqual(again.terms, r.terms);
  assert.equal(again.text, r.text);

  // Left out: the duty comes up from the start, the owner is told of an overrun, nobody approves.
  const p = parseRule(PATCH);
  assert.deepEqual([p.terms.notice, p.terms.per, p.terms.where], ['30d', ['device', 'advisory'], {}]);
  const bare = parseRule('---\nid: a\ntitle: "Answer in time"\nwhen: inquiry.received\nexpect: inquiry.answered\nwithin: 12h\nowner: support\n---\n');
  assert.deepEqual([bare.terms.title, bare.terms.escalate, bare.terms.approval, bare.terms.notice], ['Answer in time', 'support', 'none', '12h']);
  assert.equal(duration('45m'), 2_700_000);
});

test('a rule file that is wrong says which line and why', () => {
  const bad = (body: string, line: number | undefined, re: RegExp, name?: string) =>
    assert.throws(
      () => parseRule(body, name),
      (e: RuleError) => e instanceof RuleError && e.line === line && re.test(e.message),
      body,
    );
  const edit = (from: string, to: string) => DELETE_AFTER_ANSWER.replace(from, to);
  bad('id: a\n', 1, /begins with a line of ---/);
  bad('---\nid: a\ntitle: t\n', undefined, /end with a line of ---/);
  bad(edit('within: 30d', 'within: a month'), 7, /not a duration/);
  bad(edit('notice: 7d', 'notice: 31d'), 8, /cannot be longer than the deadline/);
  bad(edit('expect: data.deleted', 'expect: data.answered'), 6, /cannot be the one that starts the clock/);
  bad(edit('when: data.answered', 'when: duty.approved'), 5, /tsutome's own/);
  bad(edit('when: data.answered', 'when: Data Answered'), 5, /an event name/);
  bad(edit('owner: support', 'owner: the support team'), 9, /a short name for a role/);
  bad(edit('approval: required', 'approval: maybe'), 11, /required or none/);
  bad(edit('escalate: legal', 'deadline: soon'), 10, /not a key of a rule/);
  bad(edit('escalate: legal', 'owner: other'), 10, /given twice/);
  bad(edit('source:', '  source:'), 4, /only the lines under where/);
  bad(edit('owner: support\n', ''), undefined, /owner: required/);
  bad(edit('title: Delete', '- Delete'), 3, /not "key: value"/);
  bad(DELETE_AFTER_ANSWER, 2, /a rule lives in delete-after-answer\.md/, 'other.md');
  bad(edit('per:', 'x:').replace('approval: required', 'per: item, item'), 11, /appears twice/);
  assert.throws(() => formatRule({ ...parseRule(DELETE_AFTER_ANSWER).terms, title: 'two\nlines' }, 'x'), /one line only/);
});

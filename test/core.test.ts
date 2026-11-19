// The entry for services that keep their chain somewhere other than a file:
// it must work without files and without the MCP server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as core from '../src/core.js';

test('tsutome/core loads nothing that touches files or MCP', () => {
  const seen = new Set<string>();
  const outside = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const m of code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      else outside.add(spec);
    }
  };
  walk(fileURLToPath(new URL('../src/core.js', import.meta.url)));
  assert.deepEqual([...outside].sort(), ['node:crypto']);
  assert.ok(seen.size >= 5);
});

test('from the lines of a chain and the text of a rule to what is due', () => {
  const rule = core.parseRule('---\nid: answer\ntitle: Answer within three days\nwhen: data.received\nexpect: data.answered\nwithin: 3d\nowner: support\n---\nAnswer.\n', 'answer.md');
  const lines: string[] = [];
  const add = (event: string, meta: { [k: string]: string }, at: string): void => {
    const prev = lines.length ? { prev: 'sha256:' + core.sha256(lines[lines.length - 1] as string) } : {};
    lines.push(JSON.stringify({ spec: 'deedlog/v0.1', chain: 'c', seq: lines.length, ...prev, collected_at: at, meta: { event, ...meta } }));
  };
  add('rule.adopted', core.termsToMeta(rule.terms, rule.digest, 'manager'), '2026-11-01T00:00:00Z');
  add('data.received', { item: 'a' }, '2026-11-02T00:00:00Z');
  const chain = core.parseChain(lines);
  assert.deepEqual(chain.problems, []);
  const { duties } = core.evaluate(chain.entries, new Date('2026-11-06T00:00:00Z'));
  assert.deepEqual(duties.map((d) => [d.rule, d.about.item, d.status, d.dueAt]), [['answer', 'a', 'overdue', '2026-11-05T00:00:00Z']]);
  assert.equal(core.audit(chain.entries, new Date('2026-11-06T00:00:00Z')).filter((f) => f.kind === 'overdue').length, 1);
  // The text of a rule, as bytes or as a string, has one digest.
  assert.equal(core.parseRule(new TextEncoder().encode('---\nid: answer\ntitle: Answer within three days\nwhen: data.received\nexpect: data.answered\nwithin: 3d\nowner: support\n---\nAnswer.\n'), 'answer.md').digest, rule.digest);
});

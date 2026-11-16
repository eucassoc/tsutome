import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tsutome } from '../src/tsutome.js';

export const DAY = 86_400_000;

/** A clock the test moves. */
export class Clock {
  t: number;
  constructor(start = '2026-04-01T00:00:00Z') {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t);
  days(n: number): void {
    this.t += n * DAY;
  }
  hours(n: number): void {
    this.t += n * 3_600_000;
  }
}

export const DELETE_AFTER_ANSWER = `---
id: delete-after-answer
title: Delete inquiries 30 days after they are answered
source: Personal data policy, article 12.1
when: data.answered
expect: data.deleted
within: 30d
notice: 7d
owner: support
escalate: legal
approval: required
where:
  form: contact
---
Inquiries are deleted within 30 days of the day they are answered.
`;

/** A device must take a security fix within 30 days of the advisory applying to it. One duty per device and advisory. */
export const PATCH = `---
id: patch-critical
title: Apply critical fixes within 30 days
source: Product security policy 4.2
when: advisory.applies
expect: firmware.updated
within: 30d
owner: fleet
escalate: security
per: device, advisory
approval: required
---
A device takes a critical security fix within 30 days of the advisory.
`;

export async function workspace(start?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'tsutome-'));
  const clock = new Clock(start);
  const opts = { chain: join(dir, 'chain.jsonl'), rules: join(dir, 'rules'), name: 'example.test/duties', now: clock.now };
  const t = new Tsutome(opts);
  const rule = async (name: string, body: string) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(opts.rules, { recursive: true });
    const path = join(opts.rules, name);
    await writeFile(path, body);
    return path;
  };
  return { dir, clock, opts, t, rule };
}

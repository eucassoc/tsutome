// What a chain is, read from its lines: no files here, so that the same
// code reads a chain wherever it is kept (a file, a database, a Worker's
// storage, a browser's memory).
import { createHash, createHmac } from 'node:crypto';

export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** An identifier for the chain in place of one that could be guessed: an HMAC under a key the operator keeps. */
export const hmacId = (key: string, ref: string): string => createHmac('sha256', key).update(ref).digest('hex').slice(0, 32);

/** One line of the chain. */
export interface Entry {
  /** Sequence number; the line is `seq + 1`. */
  seq: number;
  /** RFC 3339, UTC, to the second, as the writer asserted it. */
  at: string;
  event: string;
  meta: { [key: string]: string };
  /** SHA-256 of the line itself. */
  digest: string;
}

export interface Problem {
  line: number;
  reason: string;
}

export interface Chain {
  /** The chain's name, from its first record. */
  name?: string;
  entries: Entry[];
  /** Digest of the last line. */
  head?: string;
  problems: Problem[];
}

/** Checks the sequence numbers and the link from each line to the one before. Every failure names its line. */
export function parseChain(lines: string[]): Chain {
  const problems: Problem[] = [];
  const entries: Entry[] = [];
  let prev: string | undefined;
  let name: string | undefined;
  lines.forEach((line, i) => {
    const n = i + 1;
    let r: { spec?: unknown; chain?: unknown; seq?: unknown; prev?: unknown; collected_at?: unknown; meta?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      problems.push({ line: n, reason: 'not JSON' });
      prev = 'sha256:' + sha256(line);
      return;
    }
    if (r.spec !== 'deedlog/v0.1') problems.push({ line: n, reason: `spec is ${JSON.stringify(r.spec)}, not "deedlog/v0.1"` });
    if (i === 0 && typeof r.chain === 'string') name = r.chain;
    if (r.chain !== name) problems.push({ line: n, reason: `chain is ${JSON.stringify(r.chain)}; the first record names ${JSON.stringify(name)}` });
    if (r.seq !== i) problems.push({ line: n, reason: `seq is ${JSON.stringify(r.seq)}; ${i} follows the line before` });
    if (r.prev !== prev) problems.push({ line: n, reason: i ? 'prev does not match the digest of the line before; a record was changed, removed or reordered' : 'the first record names a record before it' });
    prev = 'sha256:' + sha256(line);
    const meta: { [k: string]: string } = {};
    if (r.meta && typeof r.meta === 'object') for (const [k, v] of Object.entries(r.meta as object)) if (typeof v === 'string') meta[k] = v;
    const { event, ...rest } = meta;
    entries.push({ seq: i, at: typeof r.collected_at === 'string' ? r.collected_at : '', event: event ?? '', meta: rest, digest: sha256(line) });
  });
  return { ...(name ? { name } : {}), entries, ...(prev ? { head: prev.slice(7) } : {}), problems };
}

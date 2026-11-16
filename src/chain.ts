// The record of what happened: an append-only file of JSON Lines in the
// deedlog/v0.1 format. Every line names the digest of the line before it,
// so that a line changed, removed or reordered later shows. Tsutome reads
// the chain to know what is due, and appends to it; signing checkpoints,
// witnessing and time-stamping are deedlog's (`dlog`).
//
// Records hold names of events and identifiers. Never personal data, and
// never the data an event is about: use digests, and HMACs for identifiers
// that could be guessed.
import { createHash, createHmac } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { VERSION } from './version.js';

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

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

export class ChainError extends Error {}

/** Reads a chain and checks it. A file that is not there is an empty chain. */
export async function readChain(file: string): Promise<Chain> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return parseChain(text.split('\n').filter(Boolean));
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

export interface AppendOptions {
  /** The chain's name, used when the file is new. An existing chain keeps its own. */
  name: string;
  now?: () => Date;
}

/**
 * Appends a record of `event`. Several processes may append to one file: the
 * file is locked, read, and written while the lock is held, so that each
 * record names the one before it. A chain that does not verify is not
 * appended to.
 */
export async function appendRecord(file: string, event: string, meta: { [key: string]: string | number | undefined }, opts: AppendOptions): Promise<Entry> {
  await mkdir(dirname(file), { recursive: true });
  const release = await lock(file + '.lock');
  try {
    const chain = await readChain(file);
    if (chain.problems.length) {
      const p = chain.problems[0] as Problem;
      throw new ChainError(`${file}: line ${p.line}: ${p.reason}`);
    }
    const at = (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const clean: { [k: string]: string } = { event };
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== '' && k !== 'event') clean[k] = String(v);
    const name = chain.name ?? opts.name;
    // The subject is the event itself: there is no body to keep elsewhere.
    const body = JSON.stringify({ ...clean, at });
    const record = {
      spec: 'deedlog/v0.1',
      chain: name,
      seq: chain.entries.length,
      ...(chain.head ? { prev: 'sha256:' + chain.head } : {}),
      collected_at: at,
      source: { type: 'tsutome', id: name, collector: `tsutome ${VERSION}` },
      subject: { media_type: 'application/json', size: Buffer.byteLength(body), digest: { sha256: sha256(body) } },
      meta: clean,
    };
    const line = JSON.stringify(record);
    await appendFile(file, line + '\n');
    const { event: _e, ...rest } = clean;
    return { seq: record.seq, at, event, meta: rest, digest: sha256(line) };
  } finally {
    await release();
  }
}

/** A lock file, held for the length of one append. One left behind by a process that died is taken over. */
async function lock(path: string): Promise<() => Promise<void>> {
  for (let i = 0; ; i++) {
    try {
      const h = await open(path, 'wx');
      await h.close();
      return () => unlink(path).catch(() => undefined);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 10_000) await unlink(path).catch(() => undefined);
      else if (i > 500) throw new ChainError(`${path}: another process holds the chain`);
      else await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
}

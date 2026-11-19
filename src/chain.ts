// The record of what happened: an append-only file of JSON Lines in the
// deedlog/v0.1 format. Every line names the digest of the line before it,
// so that a line changed, removed or reordered later shows. Tsutome reads
// the chain to know what is due, and appends to it; signing checkpoints,
// witnessing and time-stamping are deedlog's (`dlog`).
//
// Records hold names of events and identifiers. Never personal data, and
// never the data an event is about: use digests, and HMACs for identifiers
// that could be guessed.
import { appendFile, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseChain, sha256, type Chain, type Entry, type Problem } from './record.js';
import { VERSION } from './version.js';

export { hmacId, parseChain, sha256, type Chain, type Entry, type Problem } from './record.js';

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

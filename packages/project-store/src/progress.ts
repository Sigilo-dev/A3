import { open, readdir } from 'node:fs/promises';
import { canonicalJson, parseJson } from './json.js';
import { sha256 } from './codec.js';
import { checkedPath, fileBytes } from './reader.js';
import { writeExclusive } from './write-io.js';
import type { JsonValue } from '@a3/domain';
import type { ProgressEvent, WriteIntent } from './service-types.js';

export const progressProtocol = 'a3.store.detached-link/1';
export const transactionRoot = '.a3/local/transactions';
export const jsonBytes = (value: unknown): Uint8Array => Buffer.from(canonicalJson(value as JsonValue) + '\n');
const fingerprint = (value: unknown): string => sha256(jsonBytes(value));
export class ProgressLog {
  #seq = 0;
  #previousHash = '0'.repeat(64);
  constructor(readonly root: string, readonly folder: string) {}
  async intent(value: WriteIntent): Promise<void> {
    await writeExclusive(this.root, `${this.folder}/intent.json`, jsonBytes(value));
    await writeExclusive(this.root, `${this.folder}/progress.ndjson`, Buffer.from(''));
    await this.append('intent', { detail: fingerprint(value) });
  }
  async append(event: ProgressEvent['event'], data: { index?: number; detail?: string } = {}): Promise<void> {
    const body = { schemaVersion: '1.0.0' as const, seq: this.#seq + 1, previousHash: this.#previousHash, event, ...data };
    const record = { ...body, hash: fingerprint(body) };
    const handle = await open(await checkedPath(this.root, `${this.folder}/progress.ndjson`, 'file'), 'a');
    try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    this.#seq = record.seq; this.#previousHash = record.hash;
  }
}
/** Only classify fully closed logs. Unknown, missing or truncated logs require E1-D1. */
export async function unfinishedTransactions(root: string, folder: string): Promise<string[]> {
  let names: string[];
  try { names = (await readdir(await checkedPath(root, folder, 'directory'))).sort(); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  const pending: string[] = [];
  for (const name of names) {
    const base = `${folder}/${name}`;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const intentParsed = parseJson(decoder.decode(await fileBytes(root, `${base}/intent.json`, 16 * 1024 * 1024)));
      if (intentParsed.concerns.length) throw new Error('ambiguous intent');
      const intent = intentParsed.value as unknown as WriteIntent;
      if (intent.schemaVersion !== '1.0.0' || intent.protocol !== progressProtocol || intent.operationId !== name || !Array.isArray(intent.entries)) throw new Error('unsupported intent');
      const text = decoder.decode(await fileBytes(root, `${base}/progress.ndjson`, 16 * 1024 * 1024));
      if (!text.endsWith('\n')) throw new Error('truncated progress');
      const records: ProgressEvent[] = [];
      for (const line of text.slice(0, -1).split('\n')) {
        const parsed = parseJson(line);
        if (parsed.concerns.length) throw new Error('ambiguous event');
        records.push(parsed.value as unknown as ProgressEvent);
      }
      let previous = '0'.repeat(64);
      for (const [index, record] of records.entries()) {
        const { hash, ...body } = record;
        if (record.schemaVersion !== '1.0.0' || record.seq !== index + 1 || record.previousHash !== previous || hash !== fingerprint(body)) throw new Error('broken progress chain');
        previous = hash;
      }
      if (records[0]?.event !== 'intent' || records[0].detail !== fingerprint(intent) || records.at(-1)?.event !== 'committed' ||
          records.filter((r) => r.event === 'committed').length !== 1 || records.at(-2)?.event !== 'verified') throw new Error('not committed');
      const expected: { event: ProgressEvent['event']; index?: number }[] = [{ event: 'intent' }, ...intent.entries.map((_, index) => ({ event: 'staged' as const, index }))];
      for (const [index, entry] of intent.entries.entries()) {
        if (entry.beforeHash !== null) expected.push({ event: 'detach-start', index }, { event: 'detached', index });
        if (entry.afterHash !== null) expected.push({ event: 'install-start', index }, { event: 'installed', index });
      }
      expected.push({ event: 'verified' }, { event: 'committed' });
      if (records.length !== expected.length || records.some((r, i) => r.event !== expected[i]!.event || r.index !== expected[i]!.index)) throw new Error('unknown progress sequence');
    } catch { pending.push(base); }
  }
  return pending;
}

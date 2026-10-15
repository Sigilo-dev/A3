import { open } from 'node:fs/promises';
import { canonicalJson } from './json.js';
import { sha256 } from './codec.js';
import { checkedPath } from './reader.js';
import { writeExclusive } from './write-io.js';
import type { JsonValue } from '@a3/domain';
import type { ProgressEvent, WriteIntent } from './service-types.js';

export const progressProtocol = 'a3.store.detached-link/1';
export const transactionRoot = '.a3/local/transactions';
export const jsonBytes = (value: unknown): Uint8Array => Buffer.from(canonicalJson(value as JsonValue) + '\n');
const fingerprint = (value: unknown): string => sha256(jsonBytes(value));
export class ProgressLog {
  #seq: number;
  #previousHash: string;
  constructor(readonly root: string, readonly folder: string, seq = 0, previousHash = '0'.repeat(64)) {
    this.#seq = seq; this.#previousHash = previousHash;
  }
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

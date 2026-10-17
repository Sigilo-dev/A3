import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { applyTurnEvent, canonical, demand, digest, initialTurnState, object, TurnError, type TurnBinding, type TurnEvent, type TurnState } from './codex-turn-state.ts';

const owners = new Set<string>();
const MAX_BYTES = 64 * 1024 * 1024;
interface RecordBody extends TurnBinding { version: 1; sequence: number; previousHash: string; event: TurnEvent; }

/** Single desktop-host writer. Every record is synced before it can authorize a tool dispatch. */
export class CodexTurnJournal {
  private previousHash = '0'.repeat(64);
  private bytes = 0;
  private closed = false;
  private blocked = false;
  private constructor(readonly path: string, private readonly file: FileHandle, private value: TurnState) {}
  get readOnly(): boolean { return this.blocked; }
  snapshot(): TurnState { return structuredClone(this.value); }

  static async open(userData: string, binding: TurnBinding): Promise<CodexTurnJournal> {
    demand(isAbsolute(userData), 'INVALID_LOCAL_SESSION_ROOT');
    const state = initialTurnState(binding), directory = resolve(userData, 'codex-turns');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    demand(info.isDirectory() && !info.isSymbolicLink() && (await realpath(directory)).toLowerCase() === directory.toLowerCase(), 'LOCAL_SESSION_PATH_CHANGED');
    const path = join(await realpath(directory), digest(binding) + '.jsonl');
    demand(!owners.has(path), 'LOCAL_SESSION_BUSY');
    owners.add(path);
    let file: FileHandle | undefined;
    try {
      try { const stat = await lstat(path); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'LOCAL_SESSION_UNREADABLE'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      file = await open(path, 'a+', 0o600);
      const journal = new CodexTurnJournal(path, file, state);
      const bytes = await file.readFile(); journal.bytes = bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset);
        if (end < 0) { journal.corrupt(); break; }
        try {
          const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end)));
          demand(object(record) && record.version === 1 && record.projectId === binding.projectId && record.rootIdentity === binding.rootIdentity &&
            record.sequence === journal.value.sequence + 1 && record.previousHash === journal.previousHash && object(record.event));
          const { hash, ...body } = record;
          demand(hash === digest(body));
          const next = applyTurnEvent(journal.value, record.event as TurnEvent);
          next.sequence = Number(record.sequence);
          journal.value = next; journal.previousHash = String(hash);
        } catch { journal.corrupt(); break; }
        offset = end + 1;
      }
      return journal;
    } catch (error) { owners.delete(path); await file?.close(); throw error; }
  }

  private corrupt(): void {
    this.blocked = true;
    this.value = applyTurnEvent(this.value, { type: 'diagnostic', code: 'LOCAL_JOURNAL_CORRUPT', uncertain: true });
  }

  async append(event: TurnEvent): Promise<void> {
    demand(!this.closed && !this.blocked, 'LOCAL_SESSION_READ_ONLY');
    const next = applyTurnEvent(this.value, event);
    const body: RecordBody = { version: 1, projectId: this.value.projectId, rootIdentity: this.value.rootIdentity,
      sequence: this.value.sequence + 1, previousHash: this.previousHash, event };
    const hash = digest(body), bytes = Buffer.from(canonical({ ...body, hash }) + '\n');
    demand(bytes.length <= 2 * 1024 * 1024 && this.bytes + bytes.length <= MAX_BYTES, 'LOCAL_SESSION_SIZE_LIMIT');
    try {
      demand((await this.file.stat()).size === this.bytes, 'LOCAL_SESSION_CHANGED');
      await this.file.writeFile(bytes); await this.file.sync();
    } catch {
      this.blocked = true;
      this.value = applyTurnEvent(this.value, { type: 'diagnostic', code: 'LOCAL_JOURNAL_WRITE_FAILED', uncertain: true });
      throw new TurnError('LOCAL_JOURNAL_WRITE_FAILED');
    }
    this.bytes += bytes.length; this.previousHash = hash;
    next.sequence = body.sequence; this.value = next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.file.close(); } finally { owners.delete(this.path); }
  }
}

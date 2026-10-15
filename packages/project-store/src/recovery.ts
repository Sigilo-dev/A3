import { lstat, readdir, rename, stat } from 'node:fs/promises';
import { issue, sha256 } from './codec.js';
import { object, parseJson } from './json.js';
import { checkedPath, fileBytes, resolvePortablePath } from './reader.js';
import { jsonBytes, ProgressLog, progressProtocol, transactionRoot } from './progress.js';
import { absentPath, ensureDirectories, installExclusive, writeExclusive } from './write-io.js';
import type { FaultPhase, ProgressEvent, ServiceOptions, WriteIntent } from './service-types.js';
import type { Actor, ErrorCode, JsonValue } from '@a3/domain';
import type { StoreDiagnostic } from './types.js';
import type { Capability } from './capabilities.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const journalLimit = 16 * 1024 * 1024;
const fingerprint = (value: unknown): string => sha256(jsonBytes(value));
const exists = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

interface FileState { hash: string | null; identity: string | null; problem?: string; }
interface Journal {
  folder: string;
  intent: WriteIntent;
  records: ProgressEvent[];
  seq: number;
  lastHash: string;
  decision?: 'confirm' | 'rollback' | 'conflict';
  terminal?: 'committed' | 'rolled-back' | 'conflict';
  terminalDetail?: string;
}
interface RecoveryOptions {
  projectId?: string;
  authenticatedActor: Actor;
  maxBytes: number;
  authorizeWrite(paths: readonly string[], capabilities: readonly Capability[] | undefined, operationId: string): boolean | { allowed: boolean; missingCapability?: string } | Promise<boolean | { allowed: boolean; missingCapability?: string }>;
  fault?: ServiceOptions['fault'];
}
export interface RecoveryResult {
  blocked: boolean;
  recovered: readonly string[];
  diagnostics: readonly StoreDiagnostic[];
}
type RecoveryDecision = 'confirm' | 'rollback' | 'conflict';
type EntryState = 'before' | 'after' | 'detached' | 'rollback-detached' | 'restored' | 'external';

function diagnostic(path: string, detail: string, message: string, code: ErrorCode = 'REVISION_CONFLICT'): StoreDiagnostic {
  return issue(path, 'io', detail, message, { code, severity: 'error' });
}
function jsonObject(value: unknown): Record<string, JsonValue> | undefined { return object(value) ? value : undefined; }
function validHash(value: unknown): value is string { return typeof value === 'string' && hashPattern.test(value); }
function validNullableHash(value: unknown): value is string | null { return value === null || validHash(value); }
function validRevision(value: unknown): boolean { return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
function isProgressEvent(value: unknown): value is ProgressEvent {
  const record = jsonObject(value);
  return !!record && record.schemaVersion === '1.0.0' && Number.isSafeInteger(record.seq) &&
    typeof record.previousHash === 'string' && validHash(record.previousHash) && typeof record.hash === 'string' && validHash(record.hash) &&
    typeof record.event === 'string';
}
function expectedCore(intent: WriteIntent): Array<{ event: ProgressEvent['event']; index?: number }> {
  const expected: Array<{ event: ProgressEvent['event']; index?: number }> = [{ event: 'intent' },
    ...intent.entries.map((_, index) => ({ event: 'staged' as const, index }))];
  for (const [index, entry] of intent.entries.entries()) {
    if (entry.beforeHash !== null) expected.push({ event: 'detach-start', index }, { event: 'detached', index });
    if (entry.afterHash !== null) expected.push({ event: 'install-start', index }, { event: 'installed', index });
  }
  expected.push({ event: 'verified' }, { event: 'committed' });
  return expected;
}
function validateOriginalEvents(records: ProgressEvent[], intent: WriteIntent, recoveryStart: number): boolean {
  const core = expectedCore(intent);
  const base = recoveryStart < 0 ? records : records.slice(0, recoveryStart);
  let cursor = 0;
  let failed = false;
  for (let index = 0; index < base.length; index++) {
    const current = base[index]!;
    if (current.event === 'failed') {
      if (failed || index !== base.length - 1 || typeof current.detail !== 'string') return false;
      failed = true;
      continue;
    }
    if (current.event === 'restored-link') {
      const previous = base[index - 1];
      if (previous?.event !== 'detached' || previous.index !== current.index || !Number.isSafeInteger(current.index)) return false;
      continue;
    }
    const expected = core[cursor];
    if (!expected || current.event !== expected.event || current.index !== expected.index) return false;
    if (cursor === 0 && current.detail !== fingerprint(intent)) return false;
    cursor++;
  }
  const originals = base.filter((record) => record.event !== 'failed');
  const committed = originals.findIndex((record) => record.event === 'committed');
  if (committed >= 0 && (committed !== originals.length - 1 || originals.at(-2)?.event !== 'verified')) return false;
  const verified = originals.findIndex((record) => record.event === 'verified');
  if (verified >= 0 && (verified !== originals.length - 1 && originals[verified + 1]?.event !== 'committed')) return false;
  return true;
}
function validateRecoveryEvents(records: ProgressEvent[], start: number, count: number): { decision?: RecoveryDecision; terminal?: Journal['terminal']; terminalDetail?: string } | undefined {
  if (start < 0) return {};
  const begin = records[start]!;
  if (begin.event !== 'recovery-start' || (begin.detail !== 'confirm' && begin.detail !== 'rollback' && begin.detail !== 'conflict') ||
      records.findIndex((record) => record.event === 'recovery-start') !== start) return undefined;
  const decision = begin.detail;
  let terminal: Journal['terminal'];
  let terminalDetail: string | undefined;
  for (let index = start + 1; index < records.length; index++) {
    const event = records[index]!;
    if (terminal) return undefined;
    if (event.event === 'recovery-progress') {
      if (!Number.isSafeInteger(event.index) || event.index! < 0 || event.index! >= count ||
          !['confirmed-target', 'rollback-detached', 'rollback-restored', 'rollback-unchanged'].includes(event.detail ?? '')) return undefined;
      if ((decision === 'confirm' && event.detail !== 'confirmed-target') ||
          (decision === 'rollback' && event.detail === 'confirmed-target') || decision === 'conflict') return undefined;
    } else if (event.event === 'recovery-committed' && decision === 'confirm') { terminal = 'committed'; terminalDetail = event.detail; }
    else if (event.event === 'recovery-rolled-back' && decision === 'rollback') { terminal = 'rolled-back'; terminalDetail = event.detail; }
    else if (event.event === 'recovery-conflict') { terminal = 'conflict'; terminalDetail = event.detail; }
    else return undefined;
  }
  return { decision, ...(terminal ? { terminal } : {}), ...(terminalDetail ? { terminalDetail } : {}) };
}
function validateIntent(value: unknown, folderName: string, folder: string, root: string): WriteIntent | undefined {
  const intent = jsonObject(value);
  if (!intent || intent.schemaVersion !== '1.0.0' || intent.protocol !== progressProtocol || intent.operationId !== folderName ||
      !uuid.test(folderName) || typeof intent.projectId !== 'string' || !uuid.test(intent.projectId) || !validHash(intent.requestHash) ||
      !Array.isArray(intent.readSet) || !Array.isArray(intent.entries) || intent.entries.length === 0 ||
      !jsonObject(intent.extensions) || !intent.extensions || intent.readSet.length > 10000 || intent.entries.length > 10000) return undefined;
  const validCapabilities = new Set(['project.read', 'mount.read', 'mount.write', 'document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'process.run',
    'network.access', 'package.install', 'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'git.branch', 'git.restore', 'export']);
  if (intent.requiredCapabilities !== undefined && (!Array.isArray(intent.requiredCapabilities) || intent.requiredCapabilities.length === 0 ||
      intent.requiredCapabilities.some((value) => typeof value !== 'string' || !validCapabilities.has(value)) ||
      new Set(intent.requiredCapabilities).size !== intent.requiredCapabilities.length)) return undefined;
  if (intent.actor !== undefined) {
    const actor = jsonObject(intent.actor);
    if (!actor || !['user', 'agent', 'extension', 'importer'].includes(String(actor.kind)) || typeof actor.id !== 'string' || actor.id.length === 0 || actor.id.length > 256) return undefined;
  }
  const readPaths = new Set<string>();
  for (const item of intent.readSet) {
    const read = jsonObject(item);
    if (!read || typeof read.path !== 'string' || !validNullableHash(read.hash) ||
        !(read.identity === null || typeof read.identity === 'string' && read.identity.length <= 256)) return undefined;
    try { resolvePortablePath(root, read.path); } catch { return undefined; }
    const folded = read.path.toLowerCase();
    if (readPaths.has(folded)) return undefined;
    readPaths.add(folded);
  }
  const paths = new Set<string>();
  for (const [index, item] of intent.entries.entries()) {
    const entry = jsonObject(item);
    if (!entry || typeof entry.path !== 'string' || !validNullableHash(entry.beforeHash) || !validNullableHash(entry.afterHash) ||
        entry.beforeHash === entry.afterHash || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
        entry.backupPath !== `${folder}/${index}.before` || entry.stagedPath !== `${folder}/${index}.staged` ||
        entry.candidatePath !== `${folder}/${index}.candidate` || entry.detachedPath !== `${folder}/${index}.detached` ||
        entry.revisionBefore !== undefined && !validRevision(entry.revisionBefore) ||
        entry.revisionAfter !== undefined && !validRevision(entry.revisionAfter)) return undefined;
    try {
      resolvePortablePath(root, entry.path);
      resolvePortablePath(root, entry.backupPath as string);
      resolvePortablePath(root, entry.stagedPath as string);
      resolvePortablePath(root, entry.candidatePath as string);
      resolvePortablePath(root, entry.detachedPath as string);
    } catch { return undefined; }
    const folded = entry.path.toLowerCase();
    if (paths.has(folded)) return undefined;
    if (folded === '.git' || folded.startsWith('.git/') || folded === '.a3/local' || folded.startsWith('.a3/local/')) return undefined;
    paths.add(folded);
    const read = (intent.readSet as unknown[]).map(jsonObject).find((candidate) => candidate?.path === entry.path);
    if ((read?.hash ?? null) !== entry.beforeHash || (entry.beforeHash === null && read && read.identity !== null)) return undefined;
  }
  // Return only after validating all values that recovery will use as paths or hashes.
  void folderName;
  return value as unknown as WriteIntent;
}
async function readState(root: string, path: string, maxBytes: number): Promise<FileState> {
  try {
    const native = await checkedPath(root, path, 'file');
    const before = await stat(native, { bigint: true });
    const bytes = await fileBytes(root, path, maxBytes);
    const after = await stat(await checkedPath(root, path, 'file'), { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) return { hash: null, identity: null, problem: 'file-replaced-during-recovery-read' };
    return { hash: sha256(bytes), identity: `${after.dev}:${after.ino}` };
  } catch (error) {
    if (exists(error)) return { hash: null, identity: null };
    return { hash: null, identity: null, problem: error instanceof Error ? error.message : 'read-failed' };
  }
}
async function readJournal(root: string, folder: string, folderName: string): Promise<Journal | undefined> {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const intentText = decoder.decode(await fileBytes(root, `${folder}/intent.json`, journalLimit));
    const parsedIntent = parseJson(intentText);
    if (parsedIntent.concerns.length) return undefined;
    const intent = validateIntent(parsedIntent.value, folderName, folder, root);
    if (!intent) return undefined;
    const raw = decoder.decode(await fileBytes(root, `${folder}/progress.ndjson`, journalLimit));
    if (!raw.endsWith('\n')) return undefined;
    const records: ProgressEvent[] = [];
    for (const line of raw.slice(0, -1).split('\n')) {
      const parsed = parseJson(line);
      if (parsed.concerns.length || !isProgressEvent(parsed.value)) return undefined;
      records.push(parsed.value);
    }
    let previous = '0'.repeat(64);
    for (const [index, record] of records.entries()) {
      const { hash, ...body } = record;
      if (record.seq !== index + 1 || record.previousHash !== previous || hash !== fingerprint(body)) return undefined;
      previous = hash;
    }
    if (!records.length || records[0]?.event !== 'intent' || records[0]?.detail !== fingerprint(intent)) return undefined;
    const recoveryStart = records.findIndex((record) => record.event === 'recovery-start');
    if (!validateOriginalEvents(records, intent, recoveryStart)) return undefined;
    const recovery = validateRecoveryEvents(records, recoveryStart, intent.entries.length);
    if (!recovery) return undefined;
    const originalRecords = recoveryStart < 0 ? records : records.slice(0, recoveryStart);
    const hadCommit = originalRecords.some((record) => record.event === 'committed');
    if (hadCommit && recoveryStart >= 0) return undefined;
    if (hadCommit && !originalRecords.some((record) => record.event === 'verified')) return undefined;
    if (recovery.terminal === 'committed' || recovery.terminal === 'rolled-back') {
      // A close marker is the final record; it is authoritative only after a validated recovery decision.
      if (records.at(-1)?.event !== (recovery.terminal === 'committed' ? 'recovery-committed' : 'recovery-rolled-back')) return undefined;
    }
    if (recovery.terminal === 'conflict' && records.at(-1)?.event !== 'recovery-conflict') return undefined;
    return { folder, intent, records, seq: records.at(-1)!.seq, lastHash: records.at(-1)!.hash,
      ...(recovery.decision ? { decision: recovery.decision } : {}), ...(recovery.terminal ? { terminal: recovery.terminal } : {}),
      ...(recovery.terminalDetail ? { terminalDetail: recovery.terminalDetail } : {}),
      ...(hadCommit && !recovery.terminal ? { terminal: 'committed' as const } : {}) };
  } catch { return undefined; }
}
function progressSeen(journal: Journal, index: number, detail: string): boolean {
  return journal.records.some((event) => event.event === 'recovery-progress' && event.index === index && event.detail === detail);
}
async function appendProgress(root: string, log: ProgressLog, journal: Journal, event: ProgressEvent['event'], data: { index?: number; detail?: string } = {}): Promise<void> {
  await log.append(event, data);
  // Keep the in-memory journal useful for idempotent per-entry progress checks.
  const seq = journal.seq + 1;
  const body = { schemaVersion: '1.0.0' as const, seq, previousHash: journal.lastHash, event, ...data };
  const record = { ...body, hash: fingerprint(body) } as ProgressEvent;
  journal.records.push(record); journal.seq = seq; journal.lastHash = record.hash;
  void root;
}
async function readEntryStates(root: string, journal: Journal, maxBytes: number): Promise<{ states: EntryState[]; issue?: string; path?: string }> {
  const { intent, folder } = journal;
  const entryPaths = new Set(intent.entries.map((entry) => entry.path.toLowerCase()));
  const readSet = new Map(intent.readSet.map((entry) => [entry.path, entry]));
  for (const expected of intent.readSet) {
    if (entryPaths.has(expected.path.toLowerCase())) continue;
    const current = await readState(root, expected.path, maxBytes);
    if (current.problem || current.hash !== expected.hash || current.identity !== expected.identity) return { states: [], issue: 'unrelated-read-set-changed', path: expected.path };
  }
  const states: EntryState[] = [];
  for (const [index, entry] of intent.entries.entries()) {
    const base = `${folder}/${index}`;
    const installStarted = journal.records.some((record) => record.event === 'install-start' && record.index === index);
    const expectedBase = readSet.get(entry.path);
    if ((expectedBase?.hash ?? null) !== entry.beforeHash || expectedBase &&
        (expectedBase.hash === null ? expectedBase.identity !== null : expectedBase.identity === null)) {
      return { states: [], issue: 'intent-read-set-mismatch', path: entry.path };
    }
    const [target, backup, staged, candidate, detached, applied, restore] = await Promise.all([
      readState(root, entry.path, maxBytes), readState(root, entry.backupPath, maxBytes), readState(root, entry.stagedPath, maxBytes),
      readState(root, entry.candidatePath, maxBytes), readState(root, entry.detachedPath, maxBytes),
      readState(root, `${base}.recovery-applied`, maxBytes), readState(root, `${base}.recovery-restore`, maxBytes)
    ]);
    const all = [target, backup, staged, candidate, detached, applied, restore];
    const problem = all.find((state) => state.problem);
    if (problem) return { states: [], issue: 'recovery-file-unavailable', path: entry.path };
    if (backup.hash !== null && backup.hash !== entry.beforeHash || staged.hash !== null && staged.hash !== entry.afterHash ||
        candidate.hash !== null && candidate.hash !== entry.afterHash || detached.hash !== null && detached.hash !== entry.beforeHash ||
        applied.hash !== null && (applied.hash !== entry.afterHash || applied.identity !== candidate.identity) ||
        restore.hash !== null && restore.hash !== entry.beforeHash) return { states: [], issue: 'recovery-artifact-hash-mismatch', path: entry.path };
    const originalIdentity = expectedBase?.identity ?? null;
    if (entry.beforeHash !== null && expectedBase?.hash !== entry.beforeHash) return { states: [], issue: 'intent-read-set-mismatch', path: entry.path };
    if (applied.hash !== null && target.hash !== null && !(restore.hash === entry.beforeHash && target.hash === entry.beforeHash && target.identity === restore.identity)) {
      return { states: [], issue: 'target-recreated-during-rollback', path: entry.path };
    }
    if (restore.hash !== null && target.hash !== null && target.identity !== restore.identity && applied.hash !== null) return { states: [], issue: 'target-recreated-during-rollback', path: entry.path };
    const before = entry.beforeHash === null ? target.hash === null : !installStarted && target.hash === entry.beforeHash && target.identity === originalIdentity;
    const restored = entry.beforeHash === null
      ? target.hash === null && entry.afterHash !== null && applied.hash === entry.afterHash && applied.identity === candidate.identity
      : target.hash === entry.beforeHash && restore.hash === entry.beforeHash && target.identity === restore.identity;
    const after = entry.afterHash === null ? target.hash === null && entry.beforeHash !== null && detached.hash === entry.beforeHash && detached.identity === originalIdentity
      : target.hash === entry.afterHash && target.identity === candidate.identity && candidate.hash === entry.afterHash;
    const detachedState = !installStarted && entry.beforeHash !== null && entry.afterHash !== null && target.hash === null && detached.hash === entry.beforeHash &&
      detached.identity === originalIdentity && candidate.hash === entry.afterHash && staged.hash === entry.afterHash;
    const rollbackDetached = target.hash === null && applied.hash === entry.afterHash && entry.afterHash !== null &&
      candidate.identity === applied.identity && (entry.beforeHash === null || detached.hash === entry.beforeHash && detached.identity === originalIdentity);
    if (before && applied.hash !== null && !restored) return { states: [], issue: 'target-recreated-after-recovery-detach', path: entry.path };
    if (after && restore.hash !== null) return { states: [], issue: 'target-recreated-during-rollback', path: entry.path };
    const state: EntryState = restored ? 'restored' : before ? 'before' : after ? 'after' : rollbackDetached ? 'rollback-detached' : detachedState ? 'detached' : 'external';
    states.push(state);
  }
  return { states };
}
function hasApplyEvent(journal: Journal): boolean {
  return journal.records.some((record) => record.event === 'detach-start' || record.event === 'detached' || record.event === 'install-start' || record.event === 'installed');
}
function recordPaths(journal: Journal): string[] { return journal.intent.entries.map((entry) => entry.path); }
async function fault(options: RecoveryOptions, phase: FaultPhase, operationId: string, index?: number, path?: string): Promise<void> {
  await options.fault?.(phase, { operationId, ...(index === undefined ? {} : { index }), ...(path === undefined ? {} : { path }) });
}
async function logConflict(root: string, journal: Journal, log: ProgressLog, options: RecoveryOptions, path: string, detail: string): Promise<StoreDiagnostic> {
  try {
    await fault(options, 'recovery-before-conflict', journal.intent.operationId, undefined, path);
    if (!journal.decision) await appendProgress(root, log, journal, 'recovery-start', { detail: 'conflict' });
    await appendProgress(root, log, journal, 'recovery-conflict', { detail: `${detail}:${path}` });
    await fault(options, 'recovery-after-conflict', journal.intent.operationId, undefined, path);
  } catch { /* The still-pending intent and project lock keep the next open fail-closed. */ }
  return diagnostic(path, detail, 'La recuperación detectó datos posteriores o evidencia ambigua. Se conservaron el archivo actual y los artefactos; revisa el conflicto antes de escribir.');
}
async function ensureRestoreCandidate(root: string, entry: WriteIntent['entries'][number], index: number, folder: string, maxBytes: number): Promise<string> {
  const restorePath = `${folder}/${index}.recovery-restore`;
  const current = await readState(root, restorePath, maxBytes);
  if (current.problem) throw new Error('restore-candidate-unavailable');
  if (current.hash !== null) {
    if (current.hash !== entry.beforeHash) throw new Error('restore-candidate-mismatch');
    return restorePath;
  }
  const bytes = await fileBytes(root, entry.backupPath, maxBytes);
  if (sha256(bytes) !== entry.beforeHash) throw new Error('backup-mismatch');
  await writeExclusive(root, restorePath, bytes);
  return restorePath;
}
async function recoverOne(root: string, journal: Journal, options: RecoveryOptions): Promise<{ resolved: boolean; blocked: boolean; diagnostic?: StoreDiagnostic }> {
  const paths = recordPaths(journal);
  if (!options.projectId || journal.intent.projectId !== options.projectId) return { resolved: false, blocked: true,
    diagnostic: diagnostic('a3.project.json', 'recovery-project-mismatch', 'El journal pertenece a otro proyecto; no se aplicó ni restauró ningún archivo.') };
  if (journal.intent.actor && (journal.intent.actor.kind !== options.authenticatedActor.kind || journal.intent.actor.id !== options.authenticatedActor.id)) {
    return { resolved: false, blocked: true, diagnostic: diagnostic('a3.project.json', 'recovery-actor-mismatch', 'La operación fue preparada por otra identidad; inicia esa identidad o revisa el conflicto.', 'PERMISSION_DENIED') };
  }
  if (journal.terminal === 'conflict') return { resolved: false, blocked: true,
    diagnostic: diagnostic('a3.project.json', 'recovery-conflict-persisted', 'Esta operación quedó en conflicto; sus bytes y copias siguen disponibles para revisión.') };
  if (journal.terminal === 'committed' || journal.terminal === 'rolled-back') return { resolved: true, blocked: false };
  let authorization: boolean | { allowed: boolean; missingCapability?: string } = false;
  try { authorization = await options.authorizeWrite(paths, journal.intent.requiredCapabilities, journal.intent.operationId); } catch { authorization = false; }
  const allowed = typeof authorization === 'boolean' ? authorization : authorization.allowed;
  if (!allowed) return { resolved: false, blocked: true, diagnostic: issue('a3.project.json', 'io', 'recovery-permission-denied',
    'El broker del host no autorizó recuperar esta operación.', { code: 'PERMISSION_DENIED', severity: 'error',
      ...(typeof authorization === 'object' && authorization.missingCapability ? { missingCapability: authorization.missingCapability } : {}) }) };
  if (journal.decision === 'conflict') {
    const log = new ProgressLog(root, journal.folder, journal.seq, journal.lastHash);
    return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, 'a3.project.json', 'recovery-conflict-resume') };
  }

  let observed = await readEntryStates(root, journal, options.maxBytes);
  if (observed.issue || observed.states.includes('external')) {
    const index = observed.issue ? journal.intent.entries.findIndex((entry) => entry.path === observed.path) : observed.states.indexOf('external');
    const path = observed.path ?? journal.intent.entries[Math.max(0, index)]?.path ?? 'a3.project.json';
    const log = new ProgressLog(root, journal.folder, journal.seq, journal.lastHash);
    return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, path, observed.issue ?? 'recovery-external-change') };
  }
  const allAfter = observed.states.every((state) => state === 'after');
  const decision: RecoveryDecision = journal.decision ?? (allAfter ? 'confirm' : 'rollback');
  if (journal.decision && journal.decision !== decision) return { resolved: false, blocked: true,
    diagnostic: diagnostic('a3.project.json', 'recovery-decision-mismatch', 'La decisión guardada no coincide con el estado observado; se conservó la operación.') };
  if (decision === 'confirm' && !allAfter || decision === 'rollback' && allAfter) {
    const log = new ProgressLog(root, journal.folder, journal.seq, journal.lastHash);
    return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, 'a3.project.json', 'recovery-state-changed') };
  }
  // An unstarted/partially staged operation has not changed project data. It can be closed
  // without requiring backups that the process had not yet produced.
  const unstarted = decision === 'rollback' && !hasApplyEvent(journal) && observed.states.every((state) => state === 'before');
  if (!unstarted) {
    for (const entry of journal.intent.entries) {
      if (entry.beforeHash !== null) {
        const backup = await readState(root, entry.backupPath, options.maxBytes);
        if (backup.problem || backup.hash !== entry.beforeHash) return { resolved: false, blocked: true,
          diagnostic: diagnostic(entry.path, 'recovery-backup-missing', 'Falta o cambió una copia anterior; no se restauró ningún destino.') };
      }
      if (entry.afterHash !== null) {
        const [staged, candidate] = await Promise.all([readState(root, entry.stagedPath, options.maxBytes), readState(root, entry.candidatePath, options.maxBytes)]);
        if (staged.problem || candidate.problem || staged.hash !== entry.afterHash || candidate.hash !== entry.afterHash) return { resolved: false, blocked: true,
          diagnostic: diagnostic(entry.path, 'recovery-proposal-missing', 'Falta o cambió la propuesta preservada; no se aplicó ni restauró ningún destino.') };
      }
    }
  }
  await fault(options, 'recovery-after-backup-check', journal.intent.operationId);
  const log = new ProgressLog(root, journal.folder, journal.seq, journal.lastHash);
  if (!journal.decision) {
    await appendProgress(root, log, journal, 'recovery-start', { detail: decision });
    await fault(options, 'recovery-after-decision', journal.intent.operationId);
  }
  if (decision === 'confirm') {
    for (const [index, entry] of journal.intent.entries.entries()) {
      const current = await readEntryStates(root, journal, options.maxBytes);
      if (current.issue || current.states.some((state) => state !== 'after')) return { resolved: false, blocked: true,
        diagnostic: await logConflict(root, journal, log, options, entry.path, 'recovery-confirmation-drift') };
      if (!progressSeen(journal, index, 'confirmed-target')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'confirmed-target' });
      await fault(options, 'recovery-after-entry', journal.intent.operationId, index, entry.path);
    }
    await fault(options, 'recovery-before-finalize', journal.intent.operationId);
    await appendProgress(root, log, journal, 'recovery-committed', { detail: 'verified-all-after-hashes' });
    await fault(options, 'recovery-after-finalize', journal.intent.operationId);
    return { resolved: true, blocked: false };
  }

  const order = journal.intent.entries.map((_, index) => index).reverse();
  for (const index of order) {
    const entry = journal.intent.entries[index]!;
    observed = await readEntryStates(root, journal, options.maxBytes);
    if (observed.issue || observed.states.includes('external')) {
      const path = observed.path ?? entry.path;
      return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, path, observed.issue ?? 'recovery-rollback-drift') };
    }
    const state = observed.states[index]!;
    if (state === 'after' && entry.afterHash !== null) {
      const recoveryPath = `${journal.folder}/${index}.recovery-applied`;
      try {
        await rename(await checkedPath(root, entry.path, 'file'), await absentPath(root, recoveryPath));
      } catch (error) {
        return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, entry.path,
          error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST' ? 'recovery-preservation-collision' : 'recovery-detach-failed') };
      }
      const moved = await readState(root, recoveryPath, options.maxBytes);
      const candidate = await readState(root, entry.candidatePath, options.maxBytes);
      if (moved.problem || moved.hash !== entry.afterHash || moved.identity !== candidate.identity) {
        // If a concurrent editor won the race, put that exact object back only if the name is free.
        try { await installExclusive(root, recoveryPath, entry.path); } catch { /* Both names/objects stay preserved. */ }
        return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, entry.path, 'recovery-detached-unexpected-bytes') };
      }
      if (!progressSeen(journal, index, 'rollback-detached')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-detached' });
      await fault(options, 'recovery-after-entry', journal.intent.operationId, index, entry.path);
    } else if (state === 'after' && entry.afterHash === null) {
      if (!progressSeen(journal, index, 'rollback-detached')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-detached' });
    } else if (state === 'rollback-detached') {
      if (!progressSeen(journal, index, 'rollback-detached')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-detached' });
    } else if (state === 'before' || state === 'restored') {
      if (!progressSeen(journal, index, 'rollback-unchanged') && state === 'before') await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-unchanged' });
    } else if (state === 'detached') {
      // The writer detached the old name and died before installing the candidate.
      if (!progressSeen(journal, index, 'rollback-detached')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-detached' });
    }
    if (entry.beforeHash !== null) {
      const afterStep = await readEntryStates(root, journal, options.maxBytes);
      if (afterStep.issue || afterStep.states[index] === 'external') return { resolved: false, blocked: true,
        diagnostic: await logConflict(root, journal, log, options, entry.path, afterStep.issue ?? 'recovery-rollback-drift') };
      if (afterStep.states[index] === 'detached' || afterStep.states[index] === 'rollback-detached' ||
          (afterStep.states[index] === 'after' && entry.afterHash === null)) {
        const restorePath = await ensureRestoreCandidate(root, entry, index, journal.folder, options.maxBytes);
        try { await installExclusive(root, restorePath, entry.path); }
        catch { return { resolved: false, blocked: true, diagnostic: await logConflict(root, journal, log, options, entry.path, 'recovery-restore-destination-conflict') }; }
        const restored = await readState(root, entry.path, options.maxBytes);
        const restore = await readState(root, restorePath, options.maxBytes);
        if (restored.problem || restored.hash !== entry.beforeHash || restored.identity !== restore.identity) return { resolved: false, blocked: true,
          diagnostic: await logConflict(root, journal, log, options, entry.path, 'recovery-restore-verification-failed') };
        if (!progressSeen(journal, index, 'rollback-restored')) await appendProgress(root, log, journal, 'recovery-progress', { index, detail: 'rollback-restored' });
        await fault(options, 'recovery-after-entry', journal.intent.operationId, index, entry.path);
      }
    }
  }
  const finalState = await readEntryStates(root, journal, options.maxBytes);
  if (finalState.issue || finalState.states.some((state) => state !== 'before' && state !== 'restored')) return { resolved: false, blocked: true,
    diagnostic: await logConflict(root, journal, log, options, finalState.path ?? 'a3.project.json', finalState.issue ?? 'recovery-rollback-verification-failed') };
  await fault(options, 'recovery-before-finalize', journal.intent.operationId);
  await appendProgress(root, log, journal, 'recovery-rolled-back', { detail: 'verified-all-before-hashes' });
  await fault(options, 'recovery-after-finalize', journal.intent.operationId);
  return { resolved: true, blocked: false };
}
async function quarantine(root: string, name: string): Promise<string> {
  const parent = `${transactionRoot}/quarantine`;
  await ensureDirectories(root, parent);
  const destination = `${parent}/q-${sha256(Buffer.from(name))}`;
  try { await lstat(resolvePortablePath(root, destination)); throw new Error('quarantine-destination-exists'); }
  catch (error) { if (!exists(error)) throw error; }
  await rename(await checkedPath(root, `${transactionRoot}/${name}`, 'directory'), await absentPath(root, destination));
  return destination;
}

/** Reconcile pending C2/E1-D1 journals before any writer is made available. */
export async function recoverTransactions(root: string, options: RecoveryOptions): Promise<RecoveryResult> {
  const recovered: string[] = [];
  const diagnostics: StoreDiagnostic[] = [];
  let names: string[];
  try {
    names = (await readdir(await checkedPath(root, transactionRoot, 'directory'))).sort();
  } catch (error) {
    if (exists(error)) return { blocked: false, recovered, diagnostics };
    return { blocked: true, recovered, diagnostics: [diagnostic(transactionRoot, 'journal-directory-unavailable', 'No se pudo leer el journal; se conserva el proyecto en solo lectura.', 'IO_FAILED')] };
  }
  const quarantined = names.includes('quarantine');
  const transactionNames = names.filter((name) => name !== 'quarantine');
  if (quarantined) {
    try {
      const qPath = `${transactionRoot}/quarantine`;
      const qNames = await readdir(await checkedPath(root, qPath, 'directory'));
      if (qNames.length) diagnostics.push(diagnostic(qPath, 'journal-quarantined', 'Hay registros aislados que requieren revisión; no se habilitó la escritura.', 'IO_FAILED'));
    } catch { diagnostics.push(diagnostic(transactionRoot, 'quarantine-unavailable', 'No se pudo inspeccionar la cuarentena; el proyecto sigue en solo lectura.', 'IO_FAILED')); }
  }
  const journals: Journal[] = [];
  const invalid: string[] = [];
  for (const name of transactionNames) {
    const folder = `${transactionRoot}/${name}`;
    const journal = await readJournal(root, folder, name);
    if (!journal) invalid.push(name);
    else if (journal.terminal === 'conflict') {
      const [reason, pathCandidate] = (journal.terminalDetail ?? '').split(':', 2);
      const validPath = [...journal.intent.entries.map((entry) => entry.path), ...journal.intent.readSet.map((entry) => entry.path)].includes(pathCandidate ?? '');
      const knownReasons = ['recovery-external-change', 'unrelated-read-set-changed', 'intent-read-set-mismatch', 'recovery-file-unavailable',
        'recovery-artifact-hash-mismatch', 'target-recreated-during-rollback', 'target-recreated-after-recovery-detach', 'recovery-state-changed',
        'recovery-confirmation-drift', 'recovery-rollback-drift', 'recovery-rollback-verification-failed', 'recovery-detached-unexpected-bytes',
        'recovery-restore-destination-conflict', 'recovery-restore-verification-failed', 'recovery-preservation-collision', 'recovery-detach-failed'];
      diagnostics.push(diagnostic(validPath ? pathCandidate! : `${folder}/intent.json`, knownReasons.includes(reason ?? '') ? reason! : 'recovery-conflict-persisted',
        'Esta operación quedó en conflicto; sus bytes y copias siguen disponibles para revisión.'));
    }
    else if (!journal.terminal) journals.push(journal);
  }
  if (invalid.length) {
    for (const name of invalid) {
      try {
        await fault(options, 'recovery-before-quarantine', name);
        const isolated = await quarantine(root, name);
        diagnostics.push(diagnostic(isolated, 'journal-quarantined', `Registro truncado, inválido o no compatible aislado desde ${folderFor(name)}; sus bytes se conservaron.`, 'IO_FAILED'));
        await fault(options, 'recovery-after-quarantine', name, undefined, isolated);
      } catch {
        diagnostics.push(diagnostic(`${transactionRoot}/${name}`, 'journal-isolation-failed', 'No se pudo aislar el registro inválido; el proyecto sigue en solo lectura.', 'IO_FAILED'));
      }
    }
    return { blocked: true, recovered, diagnostics };
  }
  if (diagnostics.length || journals.length === 0) return { blocked: diagnostics.length > 0, recovered, diagnostics };
  if (journals.length > 1) return { blocked: true, recovered, diagnostics: [diagnostic(transactionRoot, 'multiple-pending-journals', 'Hay más de una transacción pendiente; no se eligió un orden de recuperación.') ] };
  const journal = journals[0]!;
  try {
    const result = await recoverOne(root, journal, options);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (result.resolved) recovered.push(journal.intent.operationId);
    return { blocked: result.blocked, recovered, diagnostics };
  } catch (error) {
    diagnostics.push(diagnostic(`${journal.folder}/progress.ndjson`, 'recovery-interrupted', 'La recuperación se interrumpió. Los artefactos permanecen disponibles; vuelve a abrir para reanudarla.', 'IO_FAILED'));
    return { blocked: true, recovered, diagnostics };
  }
}
function folderFor(name: string): string { return `${transactionRoot}/${name}`; }

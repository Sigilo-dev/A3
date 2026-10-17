import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import type { JsonValue } from '@a3/domain';
import { issue, sha256 } from './codec.js';
import { canonicalJson, object, parseJson } from './json.js';
import { checkedPath, fileBytes, resolvePortablePath } from './reader.js';
import { absentPath, ensureDirectories, writeExclusive } from './write-io.js';
import type { StoreDiagnostic } from './types.js';

export const snapshotRoot = '.a3/local/recovery/snapshots';
const manifestName = 'snapshot.json';
const manifestLimit = 8 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeReasons = ['batch', 'migration', 'import', 'restore', 'agent'] as const;
export type SnapshotReason = typeof safeReasons[number];

interface SnapshotFile {
  path: string;
  exists: boolean;
  sha256: string | null;
  bytes: number;
  blob: string | null;
}
interface SnapshotManifest {
  schemaVersion: '1.0.0';
  snapshotId: string;
  projectId: string;
  operationId: string;
  reason: SnapshotReason;
  createdAt: string;
  files: SnapshotFile[];
}
export interface SnapshotSummary {
  snapshotId: string;
  projectId: string;
  operationId: string;
  reason: SnapshotReason;
  createdAt: string;
  fileCount: number;
  bytes: number;
}
export interface SnapshotRetention {
  retentionDays?: number;
  maxBytes?: number;
}
export interface SnapshotCapture {
  path: string;
  expectedHash: string | null;
  expectedIdentity?: string | null;
}
export interface CreateSnapshotRequest extends SnapshotRetention {
  snapshotId: string;
  projectId: string;
  operationId: string;
  reason: SnapshotReason;
  files: readonly SnapshotCapture[];
  now?: Date;
}
export type SnapshotResult<T> = { ok: true; value: T; diagnostics: readonly StoreDiagnostic[] } |
  { ok: false; diagnostics: readonly StoreDiagnostic[] };
export interface SnapshotContents extends SnapshotSummary { files: readonly { path: string; bytes: Uint8Array | null; sha256: string | null }[]; }

function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function bad(path: string, detail: string, message: string): StoreDiagnostic {
  return issue(path, 'io', detail, message, { code: 'IO_FAILED', severity: 'warning' });
}
/** Paths that may enter the recovery catalog. Local state and likely credential material stay outside it. */
export function snapshotPathAllowed(root: string, path: string): boolean {
  try {
    resolvePortablePath(root, path);
    const folded = path.toLowerCase();
    return folded !== '.git' && !folded.startsWith('.git/') && folded !== '.a3/local' && !folded.startsWith('.a3/local/') &&
      !/(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|private-keys?|id_(?:rsa|ed25519)(?:\.pub)?)(?:\/|$)/i.test(folded) &&
      !/(?:^|\/)(?:node_modules|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|codex-authorization)(?:\/|$)/i.test(folded) &&
      !/\.(?:key|pem|p12|pfx)$/i.test(folded);
  } catch { return false; }
}
function summary(manifest: SnapshotManifest): SnapshotSummary {
  return { snapshotId: manifest.snapshotId, projectId: manifest.projectId, operationId: manifest.operationId, reason: manifest.reason,
    createdAt: manifest.createdAt, fileCount: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}
function validManifest(value: unknown, folder: string, root: string): SnapshotManifest | undefined {
  if (!object(value) || value.schemaVersion !== '1.0.0' || value.snapshotId !== folder || !idPattern.test(folder) ||
      typeof value.projectId !== 'string' || !idPattern.test(value.projectId) || typeof value.operationId !== 'string' || !idPattern.test(value.operationId) ||
      typeof value.reason !== 'string' || !safeReasons.includes(value.reason as SnapshotReason) || typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.files) || value.files.length > 10000) return undefined;
  const paths = new Set<string>();
  const files: SnapshotFile[] = [];
  for (const [index, raw] of value.files.entries()) {
    if (!object(raw) || typeof raw.path !== 'string' || !snapshotPathAllowed(root, raw.path) || typeof raw.exists !== 'boolean' ||
        !(raw.sha256 === null || typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256)) ||
        !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 ||
        !(raw.blob === null || raw.blob === `files/${index}.bin`)) return undefined;
    const folded = raw.path.toLowerCase();
    if (paths.has(folded) || raw.exists !== (raw.blob !== null) || raw.exists !== (raw.sha256 !== null) ||
        (!raw.exists && raw.bytes !== 0)) return undefined;
    paths.add(folded);
    files.push(raw as unknown as SnapshotFile);
  }
  return { schemaVersion: '1.0.0', snapshotId: folder, projectId: value.projectId, operationId: value.operationId,
    reason: value.reason as SnapshotReason, createdAt: value.createdAt, files };
}
async function readManifest(root: string, id: string): Promise<SnapshotManifest | undefined> {
  if (!idPattern.test(id)) return undefined;
  try {
    const bytes = await fileBytes(root, `${snapshotRoot}/${id}/${manifestName}`, manifestLimit);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parsed = parseJson(text);
    if (parsed.concerns.length) return undefined;
    return validManifest(parsed.value, id, root);
  } catch { return undefined; }
}
async function contents(root: string, manifest: SnapshotManifest, maxFileBytes: number): Promise<SnapshotContents | undefined> {
  const files: { path: string; bytes: Uint8Array | null; sha256: string | null }[] = [];
  for (const file of manifest.files) {
    if (!file.exists) { files.push({ path: file.path, bytes: null, sha256: null }); continue; }
    try {
      const bytes = await fileBytes(root, `${snapshotRoot}/${manifest.snapshotId}/${file.blob}`, maxFileBytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) return undefined;
      files.push({ path: file.path, bytes, sha256: file.sha256 });
    } catch { return undefined; }
  }
  return { ...summary(manifest), files };
}
async function existingIdentity(root: string, path: string): Promise<string | null> {
  try {
    const info = await stat(await checkedPath(root, path, 'file'), { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function pendingOperationIds(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  let names: string[];
  try { names = await readdir(await checkedPath(root, '.a3/local/transactions', 'directory')); }
  catch (error) { if (missing(error)) return result; throw error; }
  for (const name of names) {
    if (!idPattern.test(name)) continue;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(root, `.a3/local/transactions/${name}/progress.ndjson`, manifestLimit));
      if (!text.endsWith('\n')) { result.add(name); continue; }
      const records = text.slice(0, -1).split('\n').map((line) => JSON.parse(line) as { event?: string; schemaVersion?: string; seq?: number; previousHash?: string; hash?: string; [key: string]: unknown });
      let previous = '0'.repeat(64);
      const valid = records.every((record, index) => {
        const { hash, ...body } = record;
        const expected = sha256(Buffer.from(canonicalJson(body as unknown as JsonValue) + '\n'));
        const validRecord = record.schemaVersion === '1.0.0' && record.seq === index + 1 && record.previousHash === previous && hash === expected;
        previous = hash ?? '';
        return validRecord;
      });
      const terminal = records.at(-1)?.event;
      if (!valid || !['committed', 'recovery-committed', 'recovery-rolled-back'].includes(terminal ?? '')) result.add(name);
    } catch { result.add(name); }
  }
  // Quarantined journals have no reliable operation ID or terminal record. Keep every
  // snapshot until that unresolved state has been inspected and the quarantine cleared.
  try {
    if ((await readdir(await checkedPath(root, '.a3/local/transactions/quarantine', 'directory'))).length) result.add('*');
  } catch (error) { if (!missing(error)) throw error; }
  let migrations: string[] = [];
  try { migrations = await readdir(await checkedPath(root, '.a3/local/migrations', 'directory')); }
  catch (error) { if (!missing(error)) throw error; }
  for (const name of migrations) {
    if (!idPattern.test(name)) continue;
    try {
      const intent = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(root, `.a3/local/migrations/${name}/intent.json`, manifestLimit)));
      const complete = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(root, `.a3/local/migrations/${name}/completed.json`, 1024 * 1024)));
      if (intent.concerns.length || complete.concerns.length || !object(intent.value) || !object(complete.value) ||
          complete.value.operationId !== name || complete.value.intentHash !== sha256(Buffer.from(canonicalJson(intent.value) + '\n'))) result.add(name);
    } catch { result.add(name); }
  }
  return result;
}
function retentionLimits(options: SnapshotRetention): { days: number; maxBytes: number } {
  const days = options.retentionDays ?? 30;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(days) || days < 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Retención de snapshots inválida.');
  return { days, maxBytes };
}
async function applyRetention(root: string, options: SnapshotRetention, now: Date, keep: ReadonlySet<string> = new Set()): Promise<{ bytes: number; overBudget: boolean }> {
  const { days, maxBytes } = retentionLimits(options);
  const catalog = await listSnapshots(root);
  if (!catalog.ok) throw new Error('snapshot-catalog-unavailable');
  const pending = await pendingOperationIds(root);
  let snapshots = [...catalog.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.snapshotId.localeCompare(b.snapshotId));
  let total = snapshots.reduce((sum, item) => sum + item.bytes, 0);
  const cutoff = now.getTime() - days * 86400000;
  for (const item of snapshots) {
    const old = Date.parse(item.createdAt) < cutoff;
    if (!old && total <= maxBytes) continue;
    if (pending.has('*') || pending.has(item.operationId) || keep.has(item.snapshotId)) continue;
    try {
      await rm(await checkedPath(root, `${snapshotRoot}/${item.snapshotId}`, 'directory'), { recursive: true, force: false });
      total -= item.bytes;
      snapshots = snapshots.filter((candidate) => candidate.snapshotId !== item.snapshotId);
    } catch { /* Keep a snapshot if the filesystem refuses deletion. */ }
  }
  return { bytes: total, overBudget: total > maxBytes };
}

/** Capture exact preimages and explicit absences, then publish the catalog entry last. */
export async function createSnapshot(root: string, request: CreateSnapshotRequest): Promise<SnapshotResult<SnapshotSummary>> {
  if (!idPattern.test(request.snapshotId) || !idPattern.test(request.projectId) || !idPattern.test(request.operationId) ||
      !safeReasons.includes(request.reason) || request.files.length > 10000) return { ok: false, diagnostics: [bad(snapshotRoot, 'invalid-snapshot-request', 'La solicitud del snapshot no es válida.')] };
  try {
    const eligibleFiles = request.files.filter((file) => snapshotPathAllowed(root, file.path));
    const now = request.now ?? new Date();
    const rootPath = await realpath(root);
    const finalFolder = `${snapshotRoot}/${request.snapshotId}`;
    const existing = await readManifest(rootPath, request.snapshotId);
    if (existing) {
      if (existing.projectId !== request.projectId || existing.operationId !== request.operationId || existing.reason !== request.reason) {
        return { ok: false, diagnostics: [bad(finalFolder, 'snapshot-id-reused', 'El ID ya identifica otra captura.')] };
      }
      const complete = await contents(rootPath, existing, Number.MAX_SAFE_INTEGER);
      if (!complete || complete.files.length !== eligibleFiles.length || complete.files.some((file, index) => file.path !== eligibleFiles[index]!.path || file.sha256 !== eligibleFiles[index]!.expectedHash)) {
        return { ok: false, diagnostics: [bad(finalFolder, 'snapshot-retry-mismatch', 'El snapshot existente no coincide con las precondiciones de esta operación.')] };
      }
      const retention = await applyRetention(rootPath, request, now, new Set([request.snapshotId]));
      return { ok: true, value: summary(existing), diagnostics: retention.overBudget ? [bad(snapshotRoot, 'snapshot-budget-exceeded', 'Se conservó la última copia que protege una transacción pendiente; el presupuesto de snapshots se excedió.')] : [] };
    }
    const seen = new Set<string>();
    const captures: { path: string; bytes: Uint8Array | null; hash: string | null }[] = [];
    for (const file of eligibleFiles) {
      if (!snapshotPathAllowed(rootPath, file.path) || seen.has(file.path.toLowerCase())) throw new Error('snapshot-path-invalid');
      seen.add(file.path.toLowerCase());
      const identityBefore = await existingIdentity(rootPath, file.path);
      let bytes: Uint8Array | null;
      try { bytes = await fileBytes(rootPath, file.path, Number.MAX_SAFE_INTEGER); }
      catch (error) { if (missing(error)) bytes = null; else throw error; }
      const identityAfter = await existingIdentity(rootPath, file.path);
      const actualHash = bytes ? sha256(bytes) : null;
      if (actualHash !== file.expectedHash || identityBefore !== identityAfter || file.expectedIdentity !== undefined && identityAfter !== file.expectedIdentity) throw new Error('snapshot-precondition-conflict');
      captures.push({ path: file.path, bytes, hash: actualHash });
    }
    await ensureDirectories(rootPath, snapshotRoot);
    const temporary = `${snapshotRoot}/.partial-${randomUUID()}`;
    await mkdir(await absentPath(rootPath, temporary));
    await ensureDirectories(rootPath, `${temporary}/files`);
    const files: SnapshotFile[] = [];
    for (const [index, capture] of captures.entries()) {
      const blob = capture.bytes ? `files/${index}.bin` : null;
      if (blob && capture.bytes) await writeExclusive(rootPath, `${temporary}/${blob}`, capture.bytes);
      files.push({ path: capture.path, exists: capture.bytes !== null, sha256: capture.hash, bytes: capture.bytes?.length ?? 0, blob });
    }
    const manifest: SnapshotManifest = { schemaVersion: '1.0.0', snapshotId: request.snapshotId, projectId: request.projectId,
      operationId: request.operationId, reason: request.reason, createdAt: now.toISOString(), files };
    await writeExclusive(rootPath, `${temporary}/${manifestName}`, Buffer.from(canonicalJson(manifest as unknown as JsonValue) + '\n'));
    await rename(await checkedPath(rootPath, temporary, 'directory'), await absentPath(rootPath, finalFolder));
    const retention = await applyRetention(rootPath, request, now, new Set([request.snapshotId]));
    return { ok: true, value: summary(manifest), diagnostics: retention.overBudget ? [bad(snapshotRoot, 'snapshot-budget-exceeded', 'Se conservó la última copia que protege una transacción pendiente; el presupuesto de snapshots se excedió.')] : [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'snapshot-failed';
    const code = detail === 'snapshot-precondition-conflict' ? 'REVISION_CONFLICT' : 'IO_FAILED';
    return { ok: false, diagnostics: [issue(snapshotRoot, 'io', detail, 'No se pudo capturar una copia recuperable; la operación no debe continuar.', { code })] };
  }
}

/** Catalog only complete snapshots whose manifests and every blob still match their hashes. */
export async function listSnapshots(root: string, projectId?: string): Promise<SnapshotResult<readonly SnapshotSummary[]>> {
  const diagnostics: StoreDiagnostic[] = [];
  try {
    const rootPath = await realpath(root);
    let names: string[];
    try { names = await readdir(await checkedPath(rootPath, snapshotRoot, 'directory')); }
    catch (error) { if (missing(error)) return { ok: true, value: [], diagnostics }; throw error; }
    const summaries: SnapshotSummary[] = [];
    for (const name of names.sort()) {
      if (!idPattern.test(name)) continue;
      const manifest = await readManifest(rootPath, name);
      if (!manifest) { diagnostics.push(bad(`${snapshotRoot}/${name}`, 'snapshot-invalid', 'El snapshot incompleto o inválido se conservó y no aparece como restaurable.')); continue; }
      if (projectId && manifest.projectId !== projectId) continue;
      const complete = await contents(rootPath, manifest, Number.MAX_SAFE_INTEGER);
      if (!complete) { diagnostics.push(bad(`${snapshotRoot}/${name}`, 'snapshot-blob-invalid', 'Un blob no coincide con su hash; el snapshot se conservó y no aparece como restaurable.')); continue; }
      summaries.push(summary(manifest));
    }
    return { ok: true, value: summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.snapshotId.localeCompare(b.snapshotId)), diagnostics };
  } catch (error) { return { ok: false, diagnostics: [issue(snapshotRoot, 'io', 'snapshot-catalog-unavailable', error instanceof Error ? error.message : 'No se pudo leer el catálogo.') ] }; }
}

export async function readSnapshot(root: string, snapshotId: string, projectId?: string): Promise<SnapshotResult<SnapshotContents>> {
  try {
    const rootPath = await realpath(root);
    const manifest = await readManifest(rootPath, snapshotId);
    if (!manifest || projectId && manifest.projectId !== projectId) return { ok: false, diagnostics: [bad(`${snapshotRoot}/${snapshotId}`, 'snapshot-unavailable', 'No existe un snapshot completo para este proyecto.')] };
    const value = await contents(rootPath, manifest, Number.MAX_SAFE_INTEGER);
    return value ? { ok: true, value, diagnostics: [] } : { ok: false, diagnostics: [bad(`${snapshotRoot}/${snapshotId}`, 'snapshot-blob-invalid', 'Un blob no coincide con su hash; no se puede restaurar.')] };
  } catch (error) { return { ok: false, diagnostics: [issue(`${snapshotRoot}/${snapshotId}`, 'io', 'snapshot-read-failed', error instanceof Error ? error.message : 'No se pudo leer el snapshot.') ] }; }
}

/** Used by retention diagnostics/tests; byte budget counts file payloads, not filesystem overhead. */
export async function enforceSnapshotRetention(root: string, options: SnapshotRetention = {}, now = new Date()): Promise<SnapshotResult<{ bytes: number; overBudget: boolean }>> {
  try {
    const rootPath = await realpath(root);
    return { ok: true, value: await applyRetention(rootPath, options, now), diagnostics: [] };
  } catch (error) { return { ok: false, diagnostics: [issue(snapshotRoot, 'io', 'snapshot-retention-failed', error instanceof Error ? error.message : 'No se pudo aplicar retención.') ] }; }
}

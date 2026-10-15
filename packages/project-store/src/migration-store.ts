import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@a3/domain';
import { issue, sha256 } from './codec.js';
import { canonicalJson, object, parseJson } from './json.js';
import { checkedPath, fileBytes, resolvePortablePath } from './reader.js';
import { absentPath, ensureDirectories, writeExclusive } from './write-io.js';
import type { StoreDiagnostic } from './types.js';
import type { MigrationScope } from './migrations.js';

export const migrationRoot = '.a3/local/migrations';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxJournalBytes = 16 * 1024 * 1024;
export interface PreparedMigrationFile { path: string; beforeHash: string | null; beforeIdentity: string | null; afterHash: string; bytes: Uint8Array; }
export interface PreparedMigration {
  schemaVersion: '1.0.0';
  operationId: string;
  projectId: string;
  createdAt: string;
  steps: readonly { id: string; scope: MigrationScope; fromVersion: string; toVersion: string }[];
  files: readonly { path: string; beforeHash: string | null; beforeIdentity: string | null; afterHash: string; bytes: number; blob: string }[];
}
export interface LoadedMigration extends PreparedMigration {
  outputs: readonly PreparedMigrationFile[];
  completed: boolean;
  completedIdentities?: readonly { path: string; identity: string }[];
}
function diagnostic(path: string, detail: string, message: string): StoreDiagnostic {
  return issue(path, 'io', detail, message, { code: 'IO_FAILED' });
}
function safeProjectPath(root: string, path: string): boolean {
  try {
    resolvePortablePath(root, path);
    const folded = path.toLowerCase();
    return folded !== '.git' && !folded.startsWith('.git/') && folded !== '.a3/local' && !folded.startsWith('.a3/local/');
  } catch { return false; }
}
function validateIntent(value: unknown, id: string, root: string): PreparedMigration | undefined {
  if (!object(value) || value.schemaVersion !== '1.0.0' || value.operationId !== id || !idPattern.test(id) ||
      typeof value.projectId !== 'string' || !idPattern.test(value.projectId) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.steps) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 10000) return undefined;
  const steps: PreparedMigration['steps'][number][] = [];
  for (const step of value.steps) {
    if (!object(step) || typeof step.id !== 'string' || !step.id || typeof step.scope !== 'string' ||
        !['project', '*', 'entity', 'resource', 'relation', 'workspace', 'placement', 'visual-edge', 'relation-view', 'group', 'collection', 'variable-set', 'drawing'].includes(step.scope) ||
        typeof step.fromVersion !== 'string' || typeof step.toVersion !== 'string') return undefined;
    steps.push({ id: step.id, scope: step.scope as MigrationScope, fromVersion: step.fromVersion, toVersion: step.toVersion });
  }
  const files: PreparedMigration['files'][number][] = [];
  const paths = new Set<string>();
  for (const [index, file] of value.files.entries()) {
    if (!object(file) || typeof file.path !== 'string' || !safeProjectPath(root, file.path) ||
        !(file.beforeHash === null || typeof file.beforeHash === 'string' && /^[0-9a-f]{64}$/.test(file.beforeHash)) ||
        !(file.beforeIdentity === null || typeof file.beforeIdentity === 'string' && file.beforeIdentity.length <= 256) ||
        typeof file.afterHash !== 'string' || !/^[0-9a-f]{64}$/.test(file.afterHash) || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 ||
        file.blob !== `files/${index}.json`) return undefined;
    const folded = file.path.toLowerCase(); if (paths.has(folded)) return undefined; paths.add(folded);
    files.push({ path: file.path, beforeHash: file.beforeHash, beforeIdentity: file.beforeIdentity, afterHash: file.afterHash, bytes: file.bytes as number, blob: file.blob });
  }
  return { schemaVersion: '1.0.0', operationId: id, projectId: value.projectId, createdAt: value.createdAt, steps, files };
}
export async function loadPreparedMigration(root: string, operationId: string): Promise<{ ok: true; value?: LoadedMigration } | { ok: false; diagnostic: StoreDiagnostic }> {
  if (!idPattern.test(operationId)) return { ok: false, diagnostic: diagnostic(migrationRoot, 'migration-id-invalid', 'operationId debe ser UUID.') };
  const folder = `${migrationRoot}/${operationId}`;
  try {
    const raw = await fileBytes(root, `${folder}/intent.json`, maxJournalBytes);
    const parsed = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    if (parsed.concerns.length) return { ok: false, diagnostic: diagnostic(`${folder}/intent.json`, 'migration-journal-invalid', 'La intención de migración tiene JSON ambiguo.') };
    const intent = validateIntent(parsed.value, operationId, root);
    if (!intent) return { ok: false, diagnostic: diagnostic(`${folder}/intent.json`, 'migration-journal-invalid', 'La intención de migración no cumple el formato soportado.') };
    const outputs: PreparedMigrationFile[] = [];
    for (const file of intent.files) {
      const bytes = await fileBytes(root, `${folder}/${file.blob}`, Math.max(file.bytes, 1));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.afterHash) return { ok: false, diagnostic: diagnostic(`${folder}/${file.blob}`, 'migration-stage-corrupt', 'La salida preparada no coincide con su hash.') };
      outputs.push({ path: file.path, beforeHash: file.beforeHash, beforeIdentity: file.beforeIdentity, afterHash: file.afterHash, bytes });
    }
    let completed = false;
    try {
      const completion = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(root, `${folder}/completed.json`, 1024 * 1024)));
      const marker = object(completion.value) ? completion.value : undefined;
      const identities = marker && Array.isArray(marker.files) ? marker.files : undefined;
      completed = !completion.concerns.length && !!marker && marker.operationId === operationId && marker.intentHash === sha256(Buffer.from(canonicalJson(intent as unknown as JsonValue) + '\n')) &&
        !!identities && identities.length === intent.files.length && identities.every((item, index) => object(item) && item.path === intent.files[index]!.path && typeof item.identity === 'string');
      if (completed && identities) return { ok: true, value: { ...intent, outputs, completed, completedIdentities: identities as unknown as { path: string; identity: string }[] } };
      if (!completed) return { ok: false, diagnostic: diagnostic(`${folder}/completed.json`, 'migration-completion-invalid', 'El marcador final no coincide con la intención.') };
    } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) return { ok: false, diagnostic: diagnostic(`${folder}/completed.json`, 'migration-completion-invalid', 'No se pudo verificar el marcador final.') }; }
    return { ok: true, value: { ...intent, outputs, completed } };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { ok: true };
    return { ok: false, diagnostic: diagnostic(folder, 'migration-journal-unavailable', error instanceof Error ? error.message : 'No se pudo leer la migración preparada.') };
  }
}
export async function prepareMigration(root: string, input: Omit<PreparedMigration, 'schemaVersion' | 'createdAt' | 'files'> & {
  steps: PreparedMigration['steps']; outputs: readonly PreparedMigrationFile[]; now?: Date;
}): Promise<{ ok: true; value: LoadedMigration } | { ok: false; diagnostic: StoreDiagnostic }> {
  if (!idPattern.test(input.operationId) || !idPattern.test(input.projectId) || input.outputs.length === 0) return { ok: false, diagnostic: diagnostic(migrationRoot, 'migration-request-invalid', 'La propuesta de migración no es válida.') };
  const existing = await loadPreparedMigration(root, input.operationId);
  if (!existing.ok) return existing;
  if (existing.value) {
    const same = existing.value.projectId === input.projectId && existing.value.steps.length === input.steps.length &&
      existing.value.steps.every((step, index) => { const other = input.steps[index]; return !!other && step.id === other.id && step.scope === other.scope && step.fromVersion === other.fromVersion && step.toVersion === other.toVersion; }) &&
      existing.value.outputs.length === input.outputs.length && existing.value.outputs.every((file, index) => file.path === input.outputs[index]!.path &&
        file.beforeHash === input.outputs[index]!.beforeHash && file.beforeIdentity === input.outputs[index]!.beforeIdentity && file.afterHash === sha256(input.outputs[index]!.bytes));
    if (!same) return { ok: false, diagnostic: diagnostic(`${migrationRoot}/${input.operationId}`, 'migration-operation-reused', 'El ID ya tiene otra propuesta de migración.') };
    return { ok: true, value: existing.value };
  }
  const rootPath = await realpath(root);
  const folder = `${migrationRoot}/${input.operationId}`;
  const temporary = `${migrationRoot}/.partial-${randomUUID()}`;
  try {
    const files = input.outputs.map((output, index) => {
      if (!safeProjectPath(rootPath, output.path) || output.afterHash !== sha256(output.bytes) ||
          !(output.beforeHash === null || /^[0-9a-f]{64}$/.test(output.beforeHash)) ||
          !(output.beforeIdentity === null || typeof output.beforeIdentity === 'string')) throw new Error('migration-output-invalid');
      return { path: output.path, beforeHash: output.beforeHash, beforeIdentity: output.beforeIdentity, afterHash: output.afterHash, bytes: output.bytes.length, blob: `files/${index}.json` };
    });
    if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) throw new Error('migration-path-duplicate');
    await ensureDirectories(rootPath, migrationRoot);
    await mkdir(await absentPath(rootPath, temporary));
    await ensureDirectories(rootPath, `${temporary}/files`);
    for (const [index, output] of input.outputs.entries()) await writeExclusive(rootPath, `${temporary}/files/${index}.json`, output.bytes);
    const intent: PreparedMigration = { schemaVersion: '1.0.0', operationId: input.operationId, projectId: input.projectId,
      createdAt: (input.now ?? new Date()).toISOString(), steps: input.steps, files };
    await writeExclusive(rootPath, `${temporary}/intent.json`, Buffer.from(canonicalJson(intent as unknown as JsonValue) + '\n'));
    await rename(await checkedPath(rootPath, temporary, 'directory'), await absentPath(rootPath, folder));
    const loaded = await loadPreparedMigration(rootPath, input.operationId);
    return loaded.ok && loaded.value ? { ok: true, value: loaded.value } : { ok: false, diagnostic: loaded.ok ? diagnostic(folder, 'migration-stage-unavailable', 'No se pudo verificar la salida preparada.') : loaded.diagnostic };
  } catch (error) { return { ok: false, diagnostic: diagnostic(folder, 'migration-stage-failed', error instanceof Error ? error.message : 'No se pudo guardar la migración preparada.') }; }
}
export async function completeMigration(root: string, migration: LoadedMigration, identities: readonly { path: string; identity: string }[]): Promise<StoreDiagnostic | undefined> {
  const path = `${migrationRoot}/${migration.operationId}/completed.json`;
  const { outputs: _outputs, completed: _completed, ...intent } = migration;
  if (identities.length !== migration.files.length || identities.some((entry, index) => entry.path !== migration.files[index]!.path || !entry.identity)) {
    return diagnostic(path, 'migration-identity-missing', 'No se pudo registrar la identidad instalada de cada archivo.');
  }
  const bytes = Buffer.from(canonicalJson({ schemaVersion: '1.0.0', operationId: migration.operationId,
    intentHash: sha256(Buffer.from(canonicalJson(intent as unknown as JsonValue) + '\n')), files: identities.map((entry) => ({ ...entry })) } as unknown as JsonValue) + '\n');
  try {
    await writeExclusive(root, path, bytes);
    return undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      const existing = await fileBytes(root, path, 1024 * 1024);
      if (Buffer.compare(Buffer.from(existing), bytes) === 0) return undefined;
    }
    return diagnostic(path, 'migration-completion-failed', error instanceof Error ? error.message : 'No se pudo cerrar la migración.');
  }
}

/** Prove an unclosed migration landed by matching destinations to retained D1 candidate hardlinks. */
export async function verifyAppliedMigration(root: string, migration: LoadedMigration): Promise<readonly { path: string; identity: string }[] | undefined> {
  let names: string[];
  try { names = await readdir(await checkedPath(root, '.a3/local/transactions', 'directory')); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  const wanted = [...migration.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const name of names.sort().reverse()) {
    if (!idPattern.test(name)) continue;
    try {
      const parsed = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(await fileBytes(root, `.a3/local/transactions/${name}/intent.json`, maxJournalBytes)));
      if (parsed.concerns.length || !object(parsed.value) || parsed.value.projectId !== migration.projectId || !Array.isArray(parsed.value.entries)) continue;
      const entries = parsed.value.entries;
      if (entries.length !== wanted.length) continue;
      const identities: { path: string; identity: string }[] = [];
      let matches = true;
      for (const file of wanted) {
        const entry = entries.find((raw) => object(raw) && raw.path === file.path);
        if (!object(entry) || entry.afterHash !== file.afterHash || typeof entry.candidatePath !== 'string' ||
            !entry.candidatePath.startsWith(`.a3/local/transactions/${name}/`)) { matches = false; break; }
        const [targetBytes, candidateBytes] = await Promise.all([fileBytes(root, file.path, Math.max(file.bytes, 1)), fileBytes(root, entry.candidatePath, Math.max(file.bytes, 1))]);
        const [targetStat, candidateStat] = await Promise.all([stat(await checkedPath(root, file.path, 'file'), { bigint: true }), stat(await checkedPath(root, entry.candidatePath, 'file'), { bigint: true })]);
        const targetIdentity = `${targetStat.dev}:${targetStat.ino}`; const candidateIdentity = `${candidateStat.dev}:${candidateStat.ino}`;
        if (sha256(targetBytes) !== file.afterHash || sha256(candidateBytes) !== file.afterHash || targetIdentity !== candidateIdentity) { matches = false; break; }
        identities.push({ path: file.path, identity: targetIdentity });
      }
      if (matches) return identities;
    } catch { /* A damaged transaction is not evidence that migration output was installed. */ }
  }
  return undefined;
}

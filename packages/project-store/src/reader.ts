import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultRegistry, refKey, refOf, validateRecord, validateSnapshot, type DomainRecord, type DomainSnapshot, type Resource } from '@a3/domain';
import { decodeDocument, issue, sha256 } from './codec.js';
import { freeze } from './json.js';
import type { DecodedDocument, DocumentLocation, ProjectReadResult, ReadProjectOptions, ResourceReadResult, StoreDiagnostic } from './types.js';

const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const portable = /^(?!\/)(?!.*[\\:\x00-\x1f])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/).*(?<!\/)$/;
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export class PathError extends Error { constructor(readonly detail: string, message: string) { super(message); } }
function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function portableSegments(path: string): string[] {
  if (!path || !portable.test(path)) throw new PathError('non-portable-path', 'La ruta debe ser relativa, con / y sin segmentos vacíos, . o ...');
  const parts = path.split('/');
  if (parts.some((p) => reserved.test(p) || /[<>"|?*]/.test(p) || /[. ]$/.test(p))) {
    throw new PathError('windows-path-alias', 'La ruta contiene un nombre reservado o ambiguo en Windows.');
  }
  return parts;
}
/** Logical path validation only. Actual reads additionally check every component and realpath. */
export function resolvePortablePath(root: string, path: string): string {
  if (!isAbsolute(root)) throw new PathError('root-not-absolute', 'La raíz nativa debe ser absoluta.');
  const target = resolve(root, ...portableSegments(path));
  if (!contained(root, target)) throw new PathError('path-outside-root', 'La ruta sale del proyecto.');
  return target;
}
export async function checkedPath(root: string, path: string, kind: 'file' | 'directory'): Promise<string> {
  const target = resolvePortablePath(root, path);
  let current = root;
  const parts = portableSegments(path);
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new PathError('linked-path', 'No se siguen symlinks ni junctions del proyecto.');
    const expected = i === parts.length - 1 ? kind : 'directory';
    if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new PathError('unexpected-file-kind', 'La ruta no tiene el tipo de archivo esperado.');
    if (!contained(root, await realpath(current))) throw new PathError('path-outside-root', 'La ruta resuelta sale del proyecto.');
  }
  return target;
}
export function ioIssue(path: string, error: unknown): StoreDiagnostic {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return issue(path, 'io', error instanceof PathError ? error.detail : code === 'ENOENT' ? 'file-missing' : 'read-failed',
    error instanceof PathError ? error.message : code === 'ENOENT' ? 'Archivo o carpeta ausente.' : `No se pudo leer (${typeof code === 'string' ? code : 'IO_FAILED'}).`,
    { code: code === 'ENOENT' ? 'RESOURCE_MISSING' : error instanceof PathError ? 'PATH_UNAVAILABLE' : 'IO_FAILED' });
}
function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Los límites de lectura deben ser enteros positivos seguros.');
  return limit;
}
export async function fileBytes(root: string, path: string, maxBytes: number): Promise<Uint8Array> {
  const target = await checkedPath(root, path, 'file');
  const handle = await open(target, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new PathError('unexpected-file-kind', 'El handle no es un archivo regular.');
    if (before.size > maxBytes) throw new PathError('read-limit', 'Se excedió el presupuesto de bytes; el archivo queda intacto.');
    // Bounded even if another process grows the file between stat and read.
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new PathError('read-limit', 'El archivo creció más allá del presupuesto de lectura.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) {
      throw new PathError('file-changed-during-read', 'El archivo cambió durante la lectura; vuelve a abrirlo.');
    }
    await checkedPath(root, path, 'file');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

/** Read only the known catalog; never execute packages, follow mounts, or normalize sources. */
export async function readProject(path: string, options: ReadProjectOptions = {}): Promise<ProjectReadResult> {
  const maxDocumentBytes = positiveLimit(options.maxDocumentBytes, 16 * 1024 * 1024);
  const maxTotalBytes = positiveLimit(options.maxTotalBytes, 128 * 1024 * 1024);
  const maxDocuments = positiveLimit(options.maxDocuments, 10000);
  let root = resolve(path);
  const documents: DecodedDocument[] = [];
  const diagnostics: StoreDiagnostic[] = [];
  const records: DomainRecord[] = [];
  const locations = new Map<string, string>();
  let complete = true;
  let totalBytes = 0;
  let exhausted = false;
  function result(unavailable = false): ProjectReadResult {
    const readOnly = documents.some((d) => d.status === 'read-only');
    return freeze({ root, mode: unavailable ? 'unavailable' : readOnly ? 'read-only' : diagnostics.some((d) => d.severity === 'error') ? 'degraded' : 'ready',
      writable: false, catalogComplete: complete, documents, snapshot: { records }, diagnostics });
  }
  try {
    root = await realpath(root);
    if (!(await lstat(root)).isDirectory()) throw new PathError('root-not-directory', 'La raíz del proyecto debe ser una carpeta.');
  } catch (error) { diagnostics.push(ioIssue('a3.project.json', error)); complete = false; return result(true); }

  async function load(location: DocumentLocation, expectedId?: string, variableScope?: DocumentLocation['variableScope']): Promise<DecodedDocument | undefined> {
    if (exhausted) return undefined;
    if (documents.length >= maxDocuments || totalBytes >= maxTotalBytes) {
      complete = false; exhausted = true;
      diagnostics.push(issue(location.path, 'io', 'read-limit', 'Catálogo parcial: presupuesto de lectura agotado.', { code: 'IO_FAILED' }));
      return undefined;
    }
    try {
      const bytes = await fileBytes(root, location.path, Math.min(maxDocumentBytes, maxTotalBytes - totalBytes));
      totalBytes += bytes.length;
      const document = decodeDocument({ ...location, ...(expectedId ? { expectedId } : {}), ...(variableScope ? { variableScope } : {}) }, bytes);
      documents.push(document);
      diagnostics.push(...document.diagnostics);
      if (document.record) {
        records.push(document.record);
        locations.set(refKey(refOf(document.record)), location.path);
      }
      return document;
    } catch (error) { diagnostics.push(ioIssue(location.path, error)); complete = false; return undefined; }
  }
  async function entries(path: string): Promise<string[]> {
    if (exhausted) return [];
    try { return (await readdir(await checkedPath(root, path, 'directory'))).sort(); }
    catch (error) {
      // Optional catalog categories can be absent; a linked or unreadable folder is never treated as empty silently.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        diagnostics.push(ioIssue(path, error)); complete = false;
      }
      return [];
    }
  }
  async function catalog(folder: string, kind: DocumentLocation['kind'], workspaceId?: string, variableScope?: DocumentLocation['variableScope']): Promise<void> {
    for (const name of await entries(folder)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!uuid.test(id)) {
        diagnostics.push(issue(`${folder}/${name}`, 'schema', 'invalid-catalog-filename', 'El archivo del catálogo debe usar un UUID como nombre.')); complete = false; continue;
      }
      await load({ path: `${folder}/${name}`, kind, ...(workspaceId ? { workspaceId } : {}) }, id, variableScope);
    }
  }
  const manifest = await load({ path: 'a3.project.json', kind: 'project' });
  if (manifest?.status !== 'valid' || manifest.record?.kind !== 'project') {
    const raw = manifest?.value && typeof manifest.value === 'object' && !Array.isArray(manifest.value) ? manifest.value : undefined;
    const projectId = raw && 'projectId' in raw ? raw.projectId : undefined;
    const catalogCandidate = raw && 'catalogRoot' in raw ? raw.catalogRoot : undefined;
    const formatVersion = raw && 'formatVersion' in raw ? raw.formatVersion : undefined;
    const knownMigrationLayout = manifest?.status === 'read-only' && typeof formatVersion === 'string' && options.knownReadOnlyManifestSources?.includes(formatVersion) === true &&
      typeof projectId === 'string' && uuid.test(projectId) && typeof catalogCandidate === 'string';
    if (!knownMigrationLayout) {
      complete = false;
      // An unknown format may define a different layout. Do not guess it from unvalidated fields.
      return result(manifest?.status !== 'read-only');
    }
    try { await checkedPath(root, catalogCandidate, 'directory'); }
    catch (error) { diagnostics.push(ioIssue(catalogCandidate, error)); complete = false; }
    // This layout was opted into by the host for an exact migration source. The project remains
    // read-only until a registered step transforms and validates all affected documents.
    for (const [folder, kind] of [['entities', 'entity'], ['resources', 'resource'], ['relations', 'relation'], ['collections', 'collection']] as const) {
      await catalog(`${catalogCandidate}/${folder}`, kind);
    }
    for (const workspaceId of await entries(`${catalogCandidate}/workspaces`)) {
      if (!uuid.test(workspaceId)) { diagnostics.push(issue(`${catalogCandidate}/workspaces/${workspaceId}`, 'schema', 'invalid-workspace-folder', 'La carpeta de workspace debe usar UUID.')); complete = false; continue; }
      const base = `${catalogCandidate}/workspaces/${workspaceId}`;
      await load({ path: `${base}/workspace.json`, kind: 'workspace' }, workspaceId);
      for (const [folder, kind] of [['placements', 'placement'], ['visual-edges', 'visual-edge'], ['relation-views', 'relation-view'], ['groups', 'group'], ['drawings', 'drawing']] as const) {
        await catalog(`${base}/${folder}`, kind, workspaceId);
      }
    }
    const variables = `${catalogCandidate}/variables`;
    if ((await entries(variables)).includes('project.json')) await load({ path: `${variables}/project.json`, kind: 'variable-set' }, projectId, 'project');
    await catalog(`${variables}/workspaces`, 'variable-set', undefined, 'workspace');
    await catalog(`${variables}/entities`, 'variable-set', undefined, 'entity');
    // The manifest itself is not a current DomainRecord, so reference validation is deferred to
    // the migration output validator. Individual loaded documents have already passed schemas.
    return result();
  }
  const catalogRoot = manifest.record.value.catalogRoot;
  try { await checkedPath(root, catalogRoot, 'directory'); }
  catch (error) { diagnostics.push(ioIssue(catalogRoot, error)); complete = false; }
  for (const [folder, kind] of [['entities', 'entity'], ['resources', 'resource'], ['relations', 'relation'], ['collections', 'collection']] as const) {
    await catalog(`${catalogRoot}/${folder}`, kind);
  }
  for (const workspaceId of await entries(`${catalogRoot}/workspaces`)) {
    if (!uuid.test(workspaceId)) { diagnostics.push(issue(`${catalogRoot}/workspaces/${workspaceId}`, 'schema', 'invalid-workspace-folder', 'La carpeta de workspace debe usar UUID.')); complete = false; continue; }
    const base = `${catalogRoot}/workspaces/${workspaceId}`;
    await load({ path: `${base}/workspace.json`, kind: 'workspace' }, workspaceId);
    for (const [folder, kind] of [['placements', 'placement'], ['visual-edges', 'visual-edge'], ['relation-views', 'relation-view'], ['groups', 'group'], ['drawings', 'drawing']] as const) {
      await catalog(`${base}/${folder}`, kind, workspaceId);
    }
  }
  // VariableSet paths and scopes were ratified in E1-B; no Mount/Policy schema is invented here.
  const variables = `${catalogRoot}/variables`;
  if ((await entries(variables)).includes('project.json')) await load({ path: `${variables}/project.json`, kind: 'variable-set' }, manifest.record.value.projectId, 'project');
  await catalog(`${variables}/workspaces`, 'variable-set', undefined, 'workspace');
  await catalog(`${variables}/entities`, 'variable-set', undefined, 'entity');

  const snapshot: DomainSnapshot = { records };
  for (const { instancePath: _pointer, ...d } of validateSnapshot(snapshot, options.registry ?? defaultRegistry())) {
    diagnostics.push({ ...d, stage: 'references', path: d.ref ? locations.get(refKey(d.ref)) ?? 'a3.project.json' : 'a3.project.json' });
  }
  // Check local source existence without opening it as text or reading mounted/remote content.
  for (const record of records) if (record.kind === 'resource' && record.value.kind === 'project-file') {
    try { await checkedPath(root, record.value.path, 'file'); }
    catch (error) { diagnostics.push({ ...ioIssue(locations.get(refKey(refOf(record)))!, error), stage: 'references', pointer: '/path', ref: refOf(record) }); }
  }
  return result();
}

/** Bytes and hash of a validated project-file only. No decoding, reformatting or write API. */
export async function readProjectResource(projectRoot: string, resource: Resource, maxBytes = 128 * 1024 * 1024): Promise<ResourceReadResult> {
  const errors = validateRecord({ kind: 'resource', value: resource });
  if (errors.length) return { ok: false, diagnostics: errors.map(({ instancePath, ...d }) => ({ ...d, stage: 'schema', path: 'resource', ...(instancePath !== undefined ? { pointer: instancePath } : {}) })) };
  if (resource.kind !== 'project-file') return { ok: false, diagnostics: [issue('resource', 'io', 'external-resource-not-read', 'Los montajes y URLs requieren un servicio de capacidades explícito.', { code: 'PERMISSION_DENIED' })] };
  try {
    const root = await realpath(resolve(projectRoot));
    const bytes = await fileBytes(root, resource.path, positiveLimit(maxBytes, maxBytes));
    return { ok: true, value: { bytes, sha256: sha256(bytes), path: resource.path } };
  } catch (error) { return { ok: false, diagnostics: [ioIssue(resource.path, error)] }; }
}

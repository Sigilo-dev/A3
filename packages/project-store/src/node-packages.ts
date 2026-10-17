import { readdir } from 'node:fs/promises';
import { addDeclarativeNodePackage, declarativeNodePackageFileName, defaultRegistry, validateDeclarativeNodePackage, type DeclarativeNodePackage, type TypeRegistry } from '@a3/domain';
import { issue, sha256 } from './codec.js';
import { canonicalJson } from './json.js';
import { checkedPath, fileBytes, resolvePortablePath } from './reader.js';
import type { StoreDiagnostic } from './types.js';

const maxPackageBytes = 4 * 1024 * 1024;
const maxLockBytes = 4 * 1024 * 1024;
export const NODE_PACKAGE_API_VERSION = '1.0.0';
export type NodePackageInstallOrigin = 'builder' | 'file-import';
export type NodePackageEntryStatus = 'installed' | 'available' | 'removed' | 'integrity-mismatch' | 'lock-invalid' | 'conflict';

/** Portable project lock metadata. The artifact path is always derived from its validated ID/version. */
export interface NodePackageInstallRecord {
  packageId: string;
  version: string;
  integrity: string;
  origin: NodePackageInstallOrigin;
  license: string;
  a3ApiVersion: string;
  status: 'installed' | 'removed';
  installedAt: string;
  removedAt?: string;
}
export interface NodePackageInstallLock extends Record<string, unknown> {
  schemaVersion: '1.0.0';
  packages: NodePackageInstallRecord[];
  extensions: Record<string, unknown>;
}
export interface NodePackageEntry {
  package: DeclarativeNodePackage;
  status: NodePackageEntryStatus;
  /** SHA-256 of the exact project artifact bytes, when the artifact is readable. */
  integrity: string;
  origin?: NodePackageInstallOrigin;
  installedAt?: string;
  detail?: string;
}
export interface NodePackageImportReview {
  package: DeclarativeNodePackage;
  source: NodePackageInstallOrigin | 'project';
  integrity: string;
  destination: string;
  license: string;
  a3ApiVersion: string;
  typeIds: readonly string[];
  collectionIds: readonly string[];
  conflicts: readonly { code: string; message: string }[];
  notices: readonly string[];
  canInstall: boolean;
  action: 'install' | 'reinstall' | 'already-installed' | 'blocked';
  changesExistingInstances: false;
}
export interface DeclarativeNodePackageCatalog {
  /** Only packages whose lock entry and exact artifact hash are verified are active. */
  packages: readonly DeclarativeNodePackage[];
  entries: readonly NodePackageEntry[];
  lock: NodePackageInstallLock;
  lockExists: boolean;
  lockValid: boolean;
  registry: TypeRegistry;
  diagnostics: readonly StoreDiagnostic[];
  /** Includes absent package/lock paths so external changes are observed before writes. */
  paths: readonly string[];
}
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const packageKey = (id: string, version: string): string => `${id}@${version}`;
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? error.code : undefined; }
function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value.replace('Z', '.000Z');
}
function safeLockRecord(value: unknown): value is NodePackageInstallRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowedKeys = new Set(['packageId', 'version', 'integrity', 'origin', 'license', 'a3ApiVersion', 'status', 'installedAt', 'removedAt']);
  if (Object.keys(item).some((key) => !allowedKeys.has(key))) return false;
  if (typeof item.packageId !== 'string' || !idPattern.test(item.packageId) || typeof item.version !== 'string' || !semver.test(item.version) ||
      typeof item.integrity !== 'string' || !hashPattern.test(item.integrity) || !['builder', 'file-import'].includes(String(item.origin)) ||
      typeof item.license !== 'string' || item.license.length > 256 || typeof item.a3ApiVersion !== 'string' || !semver.test(item.a3ApiVersion) ||
      !['installed', 'removed'].includes(String(item.status)) || !validInstant(item.installedAt) ||
      item.removedAt !== undefined && !validInstant(item.removedAt)) return false;
  if ((item.status === 'removed') !== (item.removedAt !== undefined)) return false;
  try { declarativeNodePackageFileName({ manifest: { id: item.packageId, version: item.version } } as Pick<DeclarativeNodePackage, 'manifest'>); }
  catch { return false; }
  return true;
}
function emptyLock(): NodePackageInstallLock { return { schemaVersion: '1.0.0', packages: [], extensions: {} }; }
function validLock(value: unknown): value is NodePackageInstallLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lock = value as Record<string, unknown>;
  if (Object.keys(lock).some((key) => !['schemaVersion', 'packages', 'extensions'].includes(key))) return false;
  if (lock.schemaVersion !== '1.0.0' || !Array.isArray(lock.packages) || lock.packages.length > 500 || !lock.packages.every(safeLockRecord) ||
      !lock.extensions || typeof lock.extensions !== 'object' || Array.isArray(lock.extensions)) return false;
  const identities = new Set<string>();
  for (const record of lock.packages as NodePackageInstallRecord[]) {
    const key = packageKey(record.packageId, record.version);
    if (identities.has(key)) return false;
    identities.add(key);
  }
  return true;
}
export function nodePackagePath(catalogRoot: string, value: Pick<DeclarativeNodePackage, 'manifest'>): string {
  return `${catalogRoot}/node-packages/${declarativeNodePackageFileName(value)}`;
}
export function nodePackageInstallLockPath(catalogRoot: string): string { return `${catalogRoot}/node-packages.lock.json`; }
export function canonicalNodePackageBytes(value: DeclarativeNodePackage): Uint8Array {
  return Buffer.from(canonicalJson(value as unknown as import('@a3/domain').JsonValue) + '\n', 'utf8');
}
export function encodeNodePackageInstallLock(value: NodePackageInstallLock): Uint8Array {
  return Buffer.from(canonicalJson(value as unknown as import('@a3/domain').JsonValue) + '\n', 'utf8');
}
export function decodeNodePackageBytes(bytes: Uint8Array): { package?: DeclarativeNodePackage; integrity: string; diagnostics: readonly StoreDiagnostic[] } {
  const integrity = sha256(bytes);
  if (bytes.byteLength > maxPackageBytes) return { integrity, diagnostics: [issue('node-package-import', 'schema', 'node-package-size-limit', 'El paquete excede el límite de 4 MiB.')] };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '');
    const value: unknown = JSON.parse(text);
    const errors = validateDeclarativeNodePackage(value);
    if (errors.length) return { integrity, diagnostics: errors.map((error) => issue('node-package-import', 'schema', error.detail, error.message)) };
    return { package: value as DeclarativeNodePackage, integrity, diagnostics: [] };
  } catch (error) {
    return { integrity, diagnostics: [issue('node-package-import', 'syntax', 'node-package-json-invalid', error instanceof SyntaxError
      ? 'El JSON del paquete está mal formado.' : 'El archivo no es UTF-8 válido; conserva el original y exporta JSON UTF-8.')] };
  }
}

export async function readNodePackageInstallLock(root: string, catalogRoot: string): Promise<{
  lock: NodePackageInstallLock; exists: boolean; valid: boolean; integrity: string | null; diagnostics: readonly StoreDiagnostic[];
}> {
  const path = nodePackageInstallLockPath(catalogRoot);
  try {
    const bytes = await fileBytes(root, path, maxLockBytes);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!validLock(value)) throw new TypeError('El registro de paquetes no cumple su contrato.');
    return { lock: copy(value), exists: true, valid: true, integrity: sha256(bytes), diagnostics: [] };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { lock: emptyLock(), exists: false, valid: true, integrity: null, diagnostics: [] };
    return { lock: emptyLock(), exists: true, valid: false, integrity: null, diagnostics: [issue(path, 'schema', 'node-package-lock-invalid',
      'El registro de instalación es inválido o inaccesible; ningún paquete se activa y sus bytes se conservan.', { severity: 'warning' })] };
  }
}

/** Reads only fixed JSON data under the project catalog. No package path or entrypoint is opened. */
export async function readDeclarativeNodePackages(root: string, catalogRoot: string, baseRegistry: TypeRegistry = defaultRegistry()): Promise<DeclarativeNodePackageCatalog> {
  const folder = `${catalogRoot}/node-packages`, lockPath = nodePackageInstallLockPath(catalogRoot);
  const packages: DeclarativeNodePackage[] = [], entries: NodePackageEntry[] = [], paths: string[] = [lockPath], diagnostics: StoreDiagnostic[] = [];
  const lockRead = await readNodePackageInstallLock(root, catalogRoot);
  const lock = lockRead.lock; diagnostics.push(...lockRead.diagnostics);
  let registry = copy(baseRegistry) as TypeRegistry;
  let names: string[] = [];
  try {
    await checkedPath(root, folder, 'directory');
    names = (await readdir(resolvePortablePath(root, folder))).filter((name) => name.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') diagnostics.push(issue(folder, 'io', 'node-package-catalog-unavailable', 'No se pudo leer el catálogo declarativo; los tipos personalizados quedan en fallback.', { code: 'IO_FAILED', severity: 'warning' }));
  }
  if (names.length > 500) diagnostics.push(issue(folder, 'schema', 'node-package-count-limit', 'El catálogo supera 500 paquetes; los adicionales quedan sin cargar.', { severity: 'warning' }));
  const seen = new Set<string>();
  for (const name of names.slice(0, 500)) {
    const path = `${folder}/${name}`; paths.push(path);
    try {
      const bytes = await fileBytes(root, path, maxPackageBytes);
      const decoded = decodeNodePackageBytes(bytes);
      if (!decoded.package) { diagnostics.push(...decoded.diagnostics.map((item) => ({ ...item, path, severity: 'warning' as const }))); continue; }
      const pkg = decoded.package, key = packageKey(pkg.manifest.id, pkg.manifest.version);
      if (name !== declarativeNodePackageFileName(pkg)) {
        diagnostics.push(issue(path, 'schema', 'node-package-filename-mismatch', 'El nombre no coincide con package ID y versión; no se usa la ruta indicada por el paquete.', { severity: 'warning' })); continue;
      }
      if (seen.has(key)) { diagnostics.push(issue(path, 'schema', 'node-package-duplicate-artifact', `El paquete ${key} aparece más de una vez; las copias quedan inertes.`, { severity: 'warning' })); continue; }
      seen.add(key);
      const record = lock.packages.find((item) => packageKey(item.packageId, item.version) === key);
      let status: NodePackageEntryStatus = 'available', detail: string | undefined;
      if (!lockRead.valid) { status = 'lock-invalid'; detail = 'El lock inválido bloquea la activación.'; }
      else if (record && (record.integrity !== decoded.integrity || record.license !== pkg.manifest.license || record.a3ApiVersion !== pkg.manifest.a3ApiVersion)) {
        status = 'integrity-mismatch'; detail = 'El hash o los metadatos fijados del artefacto difieren del registro; se requiere revisión explícita.';
        diagnostics.push(issue(path, 'schema', 'node-package-integrity-mismatch', detail, { severity: 'warning' })); }
      else if (record?.status === 'removed') status = 'removed';
      else if (record?.status === 'installed') {
        const added = addDeclarativeNodePackage(registry, pkg);
        if (added.diagnostics.length) {
          status = 'conflict'; detail = added.diagnostics.map((item) => item.message).join(' ');
          diagnostics.push(...added.diagnostics.map((item) => issue(path, 'schema', item.detail, item.message, { severity: 'warning' })));
        } else { registry = added.registry; status = 'installed'; packages.push(pkg); }
      }
      entries.push({ package: pkg, status, integrity: decoded.integrity, ...(record ? { origin: record.origin, installedAt: record.installedAt } : {}), ...(detail ? { detail } : {}) });
    } catch (error) {
      diagnostics.push(issue(path, 'syntax', 'node-package-unreadable', error instanceof SyntaxError ? 'El JSON del paquete está mal formado; se conservan sus bytes y se usa fallback.' : 'El paquete no se pudo leer por la ruta fija del catálogo; se conserva y se usa fallback.', { severity: 'warning' }));
    }
  }
  for (const record of lock.packages) if (!seen.has(packageKey(record.packageId, record.version))) {
    const path = `${folder}/${record.packageId}--${record.version}.json`;
    paths.push(path);
    const exists = await (async () => { try { await checkedPath(root, path, 'file'); return true; } catch { return false; } })();
    if (!exists) diagnostics.push(issue(path, 'io', 'node-package-artifact-missing', `No está el artefacto fijado de ${record.packageId}@${record.version}; se conserva el fallback.`, { severity: 'warning' }));
  }
  return { packages, entries, lock, lockExists: lockRead.exists, lockValid: lockRead.valid, registry, diagnostics, paths: [...new Set(paths)] };
}

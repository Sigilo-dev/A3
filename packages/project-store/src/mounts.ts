import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Actor, Resource } from '@a3/domain';
import type { ProjectCapabilityBroker, LocalMountBinding } from './capabilities.js';
import { issue, sha256 } from './codec.js';
import type { ResourceReadResult, StoreDiagnostic } from './types.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const portable = /^(?!\/)(?!.*[\\:\x00-\x1f])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/).*(?<!\/)$/;

export class MountPathError extends Error {
  constructor(readonly detail: string, message: string, readonly failureCode: StoreDiagnostic['code'] = 'PATH_UNAVAILABLE') {
    super(message);
    this.name = 'MountPathError';
  }
}

interface ObservedPath { target: string; identities: string[]; }
export interface MountedBytes { bytes: Uint8Array; sha256: string; path: string; identity: string; }
interface ReadHooks {
  /** Internal test seam to force a directory-link swap in the validation/open window. */
  beforeOpen?: () => void | Promise<void>;
  /** Internal test seam to force a path change after the handle is open but before reading. */
  beforeRead?: () => void | Promise<void>;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function normalize(value: string): string { return value.replaceAll('\\', '/').toLowerCase(); }
function fileIdentity(stat: BigIntStats): string {
  if (stat.ino === 0n) throw new MountPathError('stable-file-identity-unavailable', 'El sistema de archivos no expone identidad estable para comprobar el montaje.');
  return stat.dev.toString(16) + ':' + stat.ino.toString(16) + ':' + (stat.mode & 0o170000n).toString(16);
}
export function validateMountRelativePath(path: string): string[] {
  if (typeof path !== 'string' || !path || !portable.test(path)) {
    throw new MountPathError('invalid-mounted-path', 'La ruta del montaje debe ser relativa y usar segmentos portables separados por /.');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || reserved.test(segment) || /[<>\"|?*]/.test(segment) || /[. ]$/.test(segment))) {
    throw new MountPathError('invalid-mounted-path', 'La ruta contiene un segmento vacío o un alias ambiguo de Windows.');
  }
  return segments;
}

async function checkRoot(binding: LocalMountBinding): Promise<{ canonical: string; identity: string }> {
  if (binding.status !== 'available') {
    const detail = binding.status === 'root-missing' ? 'mount-root-missing' : 'mount-root-changed';
    throw new MountPathError(detail, binding.status === 'root-missing'
      ? 'La carpeta montada ya no está disponible. Vuelve a seleccionarla para recuperar el montaje.'
      : 'La carpeta montada cambió de identidad. Revísala y vuelve a aprobarla.');
  }
  try {
    const canonical = await realpath(binding.canonicalRoot);
    const stat = await lstat(canonical, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || normalize(canonical) !== normalize(binding.canonicalRoot)) {
      throw new MountPathError('mount-root-changed', 'La raíz montada cambió o ahora contiene un enlace.');
    }
    const identity = fileIdentity(stat);
    if (identity !== binding.rootIdentity) throw new MountPathError('mount-root-changed', 'La raíz montada fue reemplazada desde su aprobación.');
    return { canonical, identity };
  } catch (error) {
    if (error instanceof MountPathError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new MountPathError(code === 'ENOENT' ? 'mount-root-missing' : 'mount-root-unavailable',
      code === 'ENOENT' ? 'La carpeta montada ya no está disponible. Vuelve a seleccionarla para recuperar el montaje.'
        : 'No se pudo comprobar la carpeta montada; el montaje queda sin acceso.');
  }
}

async function observePath(binding: LocalMountBinding, path: string): Promise<ObservedPath> {
  const segments = validateMountRelativePath(path);
  const { canonical } = await checkRoot(binding);
  const target = resolve(canonical, ...segments);
  if (!contained(canonical, target)) throw new MountPathError('mount-path-outside-root', 'La ruta sale de la raíz montada.');
  const identities: string[] = [];
  let current = canonical;
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    let stat: BigIntStats;
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new MountPathError(code === 'ENOENT' ? 'mount-resource-missing' : 'mount-path-unavailable',
        code === 'ENOENT' ? 'El archivo del montaje ya no existe; la referencia se conserva.' : 'No se pudo validar la ruta del montaje.');
    }
    if (stat.isSymbolicLink()) throw new MountPathError('mount-link-rejected', 'No se siguen symlinks ni junctions dentro de un montaje.');
    const final = index === segments.length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) {
      throw new MountPathError('mount-path-kind-mismatch', final ? 'La referencia no apunta a un archivo regular.' : 'Un segmento intermedio no es una carpeta.');
    }
    const physical = await realpath(current);
    if (!contained(canonical, physical)) throw new MountPathError('mount-path-outside-root', 'La ruta física sale de la raíz montada.');
    identities.push(fileIdentity(stat));
  }
  return { target, identities };
}

function samePath(left: ObservedPath, right: ObservedPath): boolean {
  return normalize(left.target) === normalize(right.target) && left.identities.length === right.identities.length &&
    left.identities.every((identity, index) => identity === right.identities[index]);
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Uint8Array> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new MountPathError('mount-path-kind-mismatch', 'El handle del montaje ya no es un archivo regular.');
  if (before.size > BigInt(maxBytes)) throw new MountPathError('mount-read-limit', 'El archivo del montaje supera el límite de lectura.');
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const amount = Math.min(64 * 1024, maxBytes - total + 1);
    const buffer = Buffer.alloc(amount);
    const { bytesRead } = await handle.read(buffer, 0, amount, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > maxBytes) throw new MountPathError('mount-read-limit', 'El archivo del montaje creció por encima del límite.');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== after.size) {
    throw new MountPathError('mount-file-changed-during-read', 'El archivo montado cambió durante la lectura; vuelve a abrirlo.');
  }
  return Buffer.concat(chunks, total);
}

/** Revalidates every component, compares file identities to the open handle, then reads only through that handle. */
export async function readLocalMountFile(binding: LocalMountBinding, path: string, maxBytes = 128 * 1024 * 1024, hooks: ReadHooks = {}): Promise<MountedBytes> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes debe ser un entero positivo seguro.');
  let initial: ObservedPath;
  try { initial = await observePath(binding, path); }
  catch (error) { throw error instanceof MountPathError ? error : new MountPathError('mount-path-unavailable', 'No se pudo resolver el archivo montado.'); }
  await hooks.beforeOpen?.();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(initial.target, 'r');
    const opened = await handle.stat({ bigint: true });
    if (fileIdentity(opened) !== initial.identities.at(-1)) {
      throw new MountPathError('mount-path-raced', 'La ruta cambió entre su validación y apertura; no se leyeron bytes.');
    }
    await hooks.beforeRead?.();
    const current = await observePath(binding, path);
    if (!samePath(initial, current) || fileIdentity(await handle.stat({ bigint: true })) !== current.identities.at(-1)) {
      throw new MountPathError('mount-path-raced', 'La ruta o uno de sus enlaces cambió antes de leer; no se leyeron bytes.');
    }
    const bytes = await readBounded(handle, maxBytes);
    const final = await observePath(binding, path);
    if (!samePath(current, final) || fileIdentity(await handle.stat({ bigint: true })) !== final.identities.at(-1)) {
      throw new MountPathError('mount-path-raced', 'La ruta cambió durante la lectura; no se usará el resultado.');
    }
    return { bytes, sha256: sha256(bytes), path, identity: current.identities.at(-1)! };
  } finally { await handle?.close(); }
}

function diagnostic(path: string, error: unknown): StoreDiagnostic {
  if (error instanceof MountPathError) return issue(path, 'io', error.detail, error.message, { code: error.failureCode });
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return issue(path, 'io', code === 'ENOENT' ? 'mount-resource-missing' : 'mount-read-failed',
    code === 'ENOENT' ? 'El archivo del montaje ya no existe; la referencia se conserva.' : 'No se pudo leer el archivo montado.',
    { code: code === 'ENOENT' ? 'RESOURCE_MISSING' : 'IO_FAILED' });
}

/** Host-only read with file identity retained for a pending writer precondition. */
export async function readMountedResourceDetailed(input: {
  projectRoot: string; projectId: string; actor: Actor; broker: ProjectCapabilityBroker; resource: Resource; maxBytes?: number;
}): Promise<{ ok: true; value: MountedBytes; diagnostics: StoreDiagnostic[] } | { ok: false; diagnostics: StoreDiagnostic[] }> {
  const resource = input.resource;
  if (resource.kind !== 'mounted-file' || !uuid.test(resource.mountId)) {
    return { ok: false, diagnostics: [issue('resource', 'schema', 'invalid-mounted-resource', 'Se requiere un Resource mounted-file válido.')] };
  }
  const decision = await input.broker.authorizeCapabilities(input.projectRoot, input.actor, input.projectId,
    ['mount.read'], 'mount.read:' + resource.id, 'apply');
  if (!decision.allowed) return { ok: false, diagnostics: [issue(resource.path, 'io', 'mount-permission-denied',
    'El broker del host denegó la lectura del montaje.', { code: 'PERMISSION_DENIED', missingCapability: decision.missingCapability ?? 'mount.read' })] };
  const binding = input.broker.getLocalMount({ root: input.projectRoot, projectId: input.projectId, mountId: resource.mountId });
  if (!binding) return { ok: false, diagnostics: [issue(resource.path, 'io', 'mount-approval-required',
    'Este proyecto solo solicita un montaje. Selecciona la carpeta local y apruébala para este proyecto.', { code: 'PERMISSION_DENIED', missingCapability: 'mount.read' })] };
  if (binding.status !== 'available') {
    const detail = binding.status === 'root-missing' ? 'mount-root-missing' : 'mount-root-changed';
    return { ok: false, diagnostics: [issue(resource.path, 'io', detail,
      binding.status === 'root-missing' ? 'La carpeta montada desapareció o se movió; vuelve a seleccionarla para recuperar la referencia.'
        : 'La carpeta montada fue reemplazada; revísala y apruébala de nuevo.', { code: 'PATH_UNAVAILABLE' })] };
  }
  try {
    const value = await readLocalMountFile(binding, resource.path, input.maxBytes);
    return { ok: true, value, diagnostics: [] };
  } catch (error) { return { ok: false, diagnostics: [diagnostic(resource.path, error)] }; }
}

/** Reads an imported mounted-file only after capability approval and an exact local mount binding. */
export async function readMountedResource(input: {
  projectRoot: string; projectId: string; actor: Actor; broker: ProjectCapabilityBroker; resource: Resource; maxBytes?: number;
}): Promise<ResourceReadResult> {
  const result = await readMountedResourceDetailed(input);
  if (!result.ok) return result;
  return { ok: true, value: { bytes: result.value.bytes, sha256: result.value.sha256, path: result.value.path } };
}

export interface MountActionPreview {
  action: 'copy' | 'move' | 'reference';
  mountId: string;
  relativePath: string;
  destinationPaths: readonly string[];
  requiredCapabilities: readonly string[];
  sourceAvailable: boolean;
  destinationConflicts: readonly string[];
  canProceed: boolean;
  reason?: string;
}

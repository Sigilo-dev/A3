import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Actor } from '@a3/domain';
import { captureAgentExecutionRoot, type ProjectCapabilityBroker } from '@a3/project-store';
import { EXTENSION_CAPABILITIES, extensionObject, extensionUuid, scopeValues, validExtensionsRequest, validProgrammedExtension,
  type ExtensionCapability, type ExtensionHostSnapshot, type ExtensionReview, type ExtensionScopes, type ExtensionsRequest,
  type ExtensionsResult, type ProgrammedExtensionManifest } from '../shared/extensions.ts';

/** No Windows launcher passed E0-C2/E5-E2. This cannot be enabled by manifests, IPC, profiles or configuration. */
export const EXTENSION_RUNTIME_AVAILABLE = false;
export interface ExtensionProjectBinding { root: string; projectId: string; sessionId: string; }
interface Binding extends ExtensionProjectBinding { key: string; }
interface RecordEntry { manifest: ProgrammedExtensionManifest; integrity: string; disabled: boolean; approvals: ExtensionScopes; }
interface PreviousVersion { manifest: ProgrammedExtensionManifest; integrity: string; }
interface LocalState { schemaVersion: '1.0.0' | '1.1.0'; key: string; projectId: string; revision: number; entries: RecordEntry[]; history: PreviousVersion[]; }
interface Pending { binding: Binding; review: ExtensionReview; sourceBytes: Uint8Array; stateHash: string; expires: number; }
export class ExtensionHostError extends Error {
  constructor(readonly code: string) { super(code); }
}
const need = (condition: unknown, code: string): void => { if (!condition) throw new ExtensionHostError(code); };
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (extensionObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const normalizedRoot = (root: string): string => resolve(root).replaceAll('\\', '/').toLowerCase();
export const extensionManifestIntegrity = (value: ProgrammedExtensionManifest): string => hash(JSON.stringify(canonical(value)));
const inside = (root: string, path: string): boolean => { const delta = relative(root, path); return delta === '' || delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta); };
function compareVersions(left: string, right: string): number {
  const split = (version: string) => {
    const build = version.indexOf('+'), withoutBuild = build < 0 ? version : version.slice(0, build), dash = withoutBuild.indexOf('-');
    const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map(BigInt);
    const prerelease = dash < 0 ? [] : withoutBuild.slice(dash + 1).split('.');
    return { core, prerelease };
  };
  const a = split(left), b = split(right);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const av = a.prerelease[index], bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^(0|[1-9]\d*)$/.test(av), bn = /^(0|[1-9]\d*)$/.test(bv);
    if (an && bn) return BigInt(av) > BigInt(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}
function subset(capability: ExtensionCapability, requested: unknown, granted: unknown): boolean {
  const declared = scopeValues(capability, requested), approved = scopeValues(capability, granted);
  return !!declared && !!approved && approved.every((value) => declared.includes(value));
}

/** Logical validation only. Passing it grants neither IO nor a runtime session. File paths are never accepted. */
export function checkExtensionInvocation(projectId: string, manifest: ProgrammedExtensionManifest, approvals: ExtensionScopes, value: unknown): { ok: boolean; code: string } {
  if (!extensionObject(value) || Object.keys(value).length !== 3 || Object.keys(value).some((key) => !['projectId', 'capability', 'target'].includes(key))) return { ok: false, code: 'EXTENSION_INVALID_INVOCATION' };
  if (value.projectId !== projectId) return { ok: false, code: 'EXTENSION_CROSS_PROJECT' };
  const cap = value.capability as ExtensionCapability;
  if (!EXTENSION_CAPABILITIES.includes(cap) || !manifest.permissions.includes(cap)) return { ok: false, code: 'EXTENSION_PERMISSION_NOT_DECLARED' };
  const requested = scopeValues(cap, manifest.scopes[cap]), granted = scopeValues(cap, approvals[cap]);
  if (typeof value.target !== 'string' || !requested?.includes(value.target)) return { ok: false, code: 'EXTENSION_OUTSIDE_SCOPE' };
  if (!granted?.includes(value.target)) return { ok: false, code: 'EXTENSION_PERMISSION_NOT_GRANTED' };
  return { ok: true, code: 'SCOPE_VALIDATED_ONLY' };
}

/** Host-only revocation hooks for a future verified runtime. Tracking does not launch or authorize anything. */
export class ExtensionLeaseRegistry {
  readonly #leases = new Map<string, { root: string; projectId: string; extensionId: string; terminate: () => void | Promise<void> }>();
  readonly #pending = new Set<Promise<void>>();
  terminationFailures = 0;
  track(root: string, projectId: string, extensionId: string, terminate: () => void | Promise<void>): string {
    const token = randomUUID(); this.#leases.set(token, { root: normalizedRoot(root), projectId, extensionId, terminate }); return token;
  }
  accepts(token: string): boolean { return this.#leases.has(token); }
  invalidate(root?: string, projectId?: string, extensionId?: string): void {
    for (const [token, lease] of this.#leases) {
      if (root !== undefined && normalizedRoot(root) !== lease.root || projectId !== undefined && projectId !== lease.projectId || extensionId !== undefined && extensionId !== lease.extensionId) continue;
      this.#leases.delete(token); // Authority ends synchronously, even if termination is slow or fails.
      const pending = Promise.resolve().then(() => lease.terminate()).catch(() => { this.terminationFailures++; });
      this.#pending.add(pending); void pending.finally(() => this.#pending.delete(pending));
    }
  }
  async settle(): Promise<void> { await Promise.all(this.#pending); }
}

export class CapabilityScopedExtensionHost {
  readonly #directory: string;
  readonly #reviews = new Map<string, Pending>();
  readonly #leases: ExtensionLeaseRegistry;
  readonly #unsubscribe: () => void;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #authorityRevision = 0;
  constructor(private readonly options: {
    stateDirectory: string; broker: ProjectCapabilityBroker; actor: Actor;
    current: (sessionId: string) => Promise<ExtensionProjectBinding>;
    confirm?: (message: string, detail: string) => Promise<boolean>;
    lifecycleCheckpoint?: (phase: 'manifest-staged' | 'before-activate') => void | Promise<void>;
    leaseRegistry?: ExtensionLeaseRegistry;
  }) {
    this.#directory = resolve(options.stateDirectory, 'extension-host');
    this.#leases = options.leaseRegistry ?? new ExtensionLeaseRegistry();
    this.#unsubscribe = options.broker.subscribeRevocations(({ root, projectId }) => {
      this.#authorityRevision++;
      this.#leases.invalidate(root, projectId);
      for (const [token, pending] of this.#reviews) if (normalizedRoot(pending.binding.root) === normalizedRoot(root) && pending.binding.projectId === projectId) this.#reviews.delete(token);
    });
  }
  async #binding(sessionId: string): Promise<Binding> {
    need(!this.#closed, 'EXTENSION_HOST_CLOSED');
    const binding = await this.options.current(sessionId);
    need(binding.sessionId === sessionId && extensionUuid(binding.projectId), 'EXTENSION_STALE_SESSION');
    let root: Awaited<ReturnType<typeof captureAgentExecutionRoot>>;
    try { root = await captureAgentExecutionRoot('extension-project', binding.root); } catch { throw new ExtensionHostError('EXTENSION_ROOT_UNAVAILABLE'); }
    need(!inside(root.path, this.#directory), 'EXTENSION_LOCAL_STATE_INSIDE_PROJECT');
    await mkdir(this.#directory, { recursive: true });
    need(resolve(await realpath(this.#directory)).toLowerCase() === this.#directory.toLowerCase(), 'EXTENSION_LOCAL_STATE_UNSAFE');
    const decision = await this.options.broker.authorizeCapabilities(root.path, this.options.actor, binding.projectId, ['project.read'], 'extension.metadata.read', 'prepare');
    need(decision.allowed, 'EXTENSION_PROJECT_PERMISSION_DENIED');
    return { ...binding, root: root.path, key: hash(`${root.path.toLowerCase()}\n${root.identity}\n${binding.projectId}`) };
  }
  async #load(binding: Binding): Promise<{ state: LocalState; fingerprint: string }> {
    const path = join(this.#directory, `${binding.key}.json`);
    try {
      const stat = await lstat(path); need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'EXTENSION_LOCAL_STATE_INVALID');
      const bytes = await readFile(path), value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      need(extensionObject(value), 'EXTENSION_LOCAL_STATE_INVALID');
      const parsed = value as Record<string, unknown>, state = parsed as unknown as LocalState;
      if (state.schemaVersion === '1.0.0' && Object.keys(parsed).length === 5) {
        state.schemaVersion = '1.1.0'; state.history = [];
      }
      need(Object.keys(parsed).length === 6 && state.schemaVersion === '1.1.0' && state.key === binding.key && state.projectId === binding.projectId &&
        Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.entries) && state.entries.length <= 100 && Array.isArray(state.history) && state.history.length <= 100, 'EXTENSION_LOCAL_STATE_INVALID');
      const ids = new Set<string>();
      for (const entry of state.entries) {
        need(extensionObject(entry) && Object.keys(entry).length === 4 && validProgrammedExtension(entry.manifest) && entry.integrity === extensionManifestIntegrity(entry.manifest) && entry.disabled === true && extensionObject(entry.approvals), 'EXTENSION_LOCAL_STATE_INVALID');
        need(!ids.has(entry.manifest.id), 'EXTENSION_LOCAL_STATE_INVALID'); ids.add(entry.manifest.id);
        for (const [capability, scope] of Object.entries(entry.approvals)) {
          need(entry.manifest.permissions.includes(capability as ExtensionCapability) && subset(capability as ExtensionCapability, entry.manifest.scopes[capability as ExtensionCapability], scope), 'EXTENSION_LOCAL_STATE_INVALID');
        }
      }
      const historyIds = new Set<string>();
      for (const prior of state.history) {
        need(extensionObject(prior) && Object.keys(prior).length === 2 && validProgrammedExtension(prior.manifest) && prior.integrity === extensionManifestIntegrity(prior.manifest) &&
          !historyIds.has(prior.manifest.id) && ids.has(prior.manifest.id), 'EXTENSION_LOCAL_STATE_INVALID');
        historyIds.add(prior.manifest.id);
      }
      return { state, fingerprint: hash(bytes) };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { state: { schemaVersion: '1.1.0', key: binding.key, projectId: binding.projectId, revision: 0, entries: [], history: [] }, fingerprint: 'absent' };
      throw new ExtensionHostError('EXTENSION_LOCAL_STATE_INVALID');
    }
  }
  async #audit(binding: Binding, operation: string, id?: string, capability?: ExtensionCapability, code = 'reviewed'): Promise<void> {
    const path = join(this.#directory, 'audit.ndjson');
    try {
      try { const stat = await lstat(path); need(stat.isFile() && !stat.isSymbolicLink(), 'EXTENSION_AUDIT_UNAVAILABLE'); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      await appendFile(path, JSON.stringify({ at: new Date().toISOString(), projectKey: binding.key, projectId: binding.projectId, operation, ...(id ? { extensionId: id } : {}), ...(capability ? { capability } : {}), code }) + '\n');
    } catch { throw new ExtensionHostError('EXTENSION_AUDIT_UNAVAILABLE'); }
  }
  async #save(binding: Binding, state: LocalState, expected: string): Promise<void> {
    const current = await this.#binding(binding.sessionId); need(current.key === binding.key, 'EXTENSION_STALE_SESSION');
    need((await this.#load(binding)).fingerprint === expected, 'EXTENSION_REVIEW_STALE');
    const serialized = JSON.stringify({ ...state, revision: state.revision + 1 }, null, 2) + '\n';
    need(state.entries.length <= 100 && state.history.length <= 100 && state.revision < Number.MAX_SAFE_INTEGER && Buffer.byteLength(serialized) <= 2 * 1024 * 1024, 'EXTENSION_LOCAL_STATE_LIMIT');
    const path = join(this.#directory, `${binding.key}.json`), temporary = join(this.#directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async #stageManifest(binding: Binding, pending: Pending): Promise<string> {
    const stagingRoot = join(this.#directory, 'staging'), stagingDirectory = join(stagingRoot, binding.key);
    await mkdir(stagingRoot, { recursive: true });
    need((await lstat(stagingRoot)).isDirectory() && !(await lstat(stagingRoot)).isSymbolicLink() && resolve(await realpath(stagingRoot)).toLowerCase() === stagingRoot.toLowerCase(), 'EXTENSION_STAGING_UNSAFE');
    await mkdir(stagingDirectory, { recursive: true });
    need((await lstat(stagingDirectory)).isDirectory() && !(await lstat(stagingDirectory)).isSymbolicLink() && resolve(await realpath(stagingDirectory)).toLowerCase() === stagingDirectory.toLowerCase(), 'EXTENSION_STAGING_UNSAFE');
    const path = join(stagingDirectory, `${hash(pending.review.manifest.id)}-${pending.review.integrity}-${pending.review.sourceIntegrity}.json`);
    const temporary = join(stagingDirectory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(pending.sourceBytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      await this.#verifyStagedManifest(binding, pending);
      return path;
    } catch (error) {
      await rm(temporary, { force: true }); await rm(path, { force: true });
      if (error instanceof ExtensionHostError) throw error;
      throw new ExtensionHostError('EXTENSION_UPDATE_STAGE_FAILED');
    }
  }
  async #verifyStagedManifest(binding: Binding, pending: Pending): Promise<void> {
    const stagingRoot = join(this.#directory, 'staging'), stagingDirectory = join(stagingRoot, binding.key);
    const path = join(stagingDirectory, `${hash(pending.review.manifest.id)}-${pending.review.integrity}-${pending.review.sourceIntegrity}.json`);
    need((await lstat(stagingRoot)).isDirectory() && !(await lstat(stagingRoot)).isSymbolicLink() && resolve(await realpath(stagingRoot)).toLowerCase() === stagingRoot.toLowerCase(), 'EXTENSION_STAGING_UNSAFE');
    need((await lstat(stagingDirectory)).isDirectory() && !(await lstat(stagingDirectory)).isSymbolicLink() && resolve(await realpath(stagingDirectory)).toLowerCase() === stagingDirectory.toLowerCase(), 'EXTENSION_STAGING_UNSAFE');
    const stat = await lstat(path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024, 'EXTENSION_STAGING_INVALID');
    const staged = await readFile(path);
    need(hash(staged) === pending.review.sourceIntegrity, 'EXTENSION_STAGING_INTEGRITY_FAILED');
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(staged)); } catch { throw new ExtensionHostError('EXTENSION_STAGING_INVALID'); }
    need(validProgrammedExtension(parsed) && extensionManifestIntegrity(parsed) === pending.review.integrity, 'EXTENSION_STAGING_INTEGRITY_FAILED');
  }
  async #clearStagedManifest(binding: Binding, pending: Pending): Promise<void> {
    const stagingDirectory = join(this.#directory, 'staging', binding.key);
    const path = join(stagingDirectory, `${hash(pending.review.manifest.id)}-${pending.review.integrity}-${pending.review.sourceIntegrity}.json`);
    try {
      const root = resolve(await realpath(stagingDirectory));
      need(root.toLowerCase() === stagingDirectory.toLowerCase() && inside(this.#directory, path), 'EXTENSION_STAGING_UNSAFE');
      const stat = await lstat(path); need(stat.isFile() && !stat.isSymbolicLink(), 'EXTENSION_STAGING_UNSAFE');
      await rm(path);
    } catch { /* A stale inert manifest is harmless; no entrypoint is loaded from staging. */ }
  }
  #snapshot(binding: Binding, state: LocalState): ExtensionHostSnapshot {
    return { projectId: binding.projectId, runtimeAvailable: EXTENSION_RUNTIME_AVAILABLE, runtimeCode: 'EXTENSION_SANDBOX_UNAVAILABLE',
      capabilities: EXTENSION_CAPABILITIES.map((capability) => ({ capability, available: false })),
      extensions: state.entries.map((entry) => ({ manifest: clone(entry.manifest), integrity: entry.integrity, disabled: entry.disabled,
        ...(state.history.find((prior) => prior.manifest.id === entry.manifest.id) ? { rollbackVersion: state.history.find((prior) => prior.manifest.id === entry.manifest.id)!.manifest.version } : {}),
        permissions: entry.manifest.permissions.map((capability) => ({ capability, requested: clone(entry.manifest.scopes[capability]!),
          ...(entry.approvals[capability] ? { approved: clone(entry.approvals[capability]) } : {}), effective: false, reason: 'sandbox-unavailable' })) })) };
  }
  async #execute(input: ExtensionsRequest): Promise<ExtensionHostSnapshot | ExtensionReview> {
    const authorityRevision = this.#authorityRevision;
    const binding = await this.#binding(input.sessionId), loaded = await this.#load(binding), state = clone(loaded.state);
    if (input.action === 'status') return this.#snapshot(binding, state);
    if (input.action === 'review') {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)); } catch { throw new ExtensionHostError('EXTENSION_MANIFEST_SYNTAX_INVALID'); }
      need(validProgrammedExtension(value), 'EXTENSION_MANIFEST_INVALID');
      const manifest = value as ProgrammedExtensionManifest, integrity = extensionManifestIntegrity(manifest), previous = state.entries.find((entry) => entry.manifest.id === manifest.id);
      need(!previous || previous.manifest.version !== manifest.version || previous.integrity === integrity, 'EXTENSION_IMMUTABLE_VERSION');
      if (previous && previous.integrity === integrity) throw new ExtensionHostError('EXTENSION_ALREADY_CURRENT');
      if (previous) need(compareVersions(manifest.version, previous.manifest.version) > 0, 'EXTENSION_VERSION_NOT_NEWER');
      const changes = EXTENSION_CAPABILITIES.flatMap((capability) => {
        const before = previous?.manifest.scopes[capability], after = manifest.scopes[capability];
        const wasDeclared = previous?.manifest.permissions.includes(capability) ?? false, isDeclared = manifest.permissions.includes(capability);
        return wasDeclared === isDeclared && JSON.stringify(canonical(before)) === JSON.stringify(canonical(after)) ? [] : [{ capability, ...(before ? { before: clone(before) } : {}), ...(after ? { after: clone(after) } : {}) }];
      });
      for (const [token, item] of this.#reviews) if (item.expires < Date.now()) this.#reviews.delete(token);
      need(this.#reviews.size < 32, 'EXTENSION_REVIEW_LIMIT');
      const review: ExtensionReview = { token: randomUUID(), manifest, integrity, sourceIntegrity: hash(input.bytes), ...(previous ? { previousVersion: previous.manifest.version } : {}), changes,
        license: manifest.license, licenseAcknowledgementRequired: true, compatible: true, clearsApprovals: !!previous, runtimeAvailable: false };
      this.#reviews.set(review.token, { binding, review: clone(review), sourceBytes: new Uint8Array(input.bytes), stateHash: loaded.fingerprint, expires: Date.now() + 5 * 60_000 });
      await this.#audit(binding, 'manifest.review', manifest.id); return clone(review);
    }
    if (input.action === 'apply') {
      const pending = this.#reviews.get(input.token); this.#reviews.delete(input.token);
      need(pending && pending.binding.key === binding.key && pending.binding.sessionId === input.sessionId && pending.expires > Date.now() && pending.stateHash === loaded.fingerprint, 'EXTENSION_REVIEW_STALE');
      const review = pending!.review;
      need(input.licenseAcknowledged, 'EXTENSION_LICENSE_REVIEW_REQUIRED');
      need(await this.options.confirm?.('Revisar y actualizar extensión desactivada', `${review.manifest.id} · ${review.previousVersion ?? 'nuevo'} → ${review.manifest.version}\nLicencia declarada: ${review.license}\nSHA-256 del manifiesto: ${review.integrity}\nPermisos y scopes solicitados (se requiere consentimiento): ${JSON.stringify(review.changes)}\nLa actualización se valida en staging y el registro previo queda disponible para rollback. Las concesiones anteriores se revocan. El código no se ejecuta: no hay sandbox Windows comprobada.`), 'EXTENSION_APPROVAL_REJECTED');
      need(authorityRevision === this.#authorityRevision, 'EXTENSION_REVIEW_STALE');
      let stagedPath: string | undefined;
      try {
        stagedPath = await this.#stageManifest(binding, pending!);
        await this.options.lifecycleCheckpoint?.('manifest-staged');
        await this.#verifyStagedManifest(binding, pending!);
        const currentBinding = await this.#binding(input.sessionId), currentState = await this.#load(currentBinding);
        need(currentBinding.key === binding.key && currentState.fingerprint === loaded.fingerprint && authorityRevision === this.#authorityRevision, 'EXTENSION_REVIEW_STALE');
        const current = state.entries.find((entry) => entry.manifest.id === review.manifest.id);
        if (current) {
          state.history = [...state.history.filter((prior) => prior.manifest.id !== review.manifest.id), { manifest: clone(current.manifest), integrity: current.integrity }];
        }
        state.entries = [...state.entries.filter((entry) => entry.manifest.id !== review.manifest.id), { manifest: clone(review.manifest), integrity: review.integrity, disabled: true, approvals: {} }];
        await this.options.lifecycleCheckpoint?.('before-activate');
        this.#leases.invalidate(binding.root, binding.projectId, review.manifest.id);
        await this.#audit(binding, 'manifest.update.activate', review.manifest.id);
        await this.#save(binding, state, loaded.fingerprint);
      } catch (error) {
        if (stagedPath) await this.#clearStagedManifest(binding, pending!);
        if (error instanceof ExtensionHostError) throw error;
        throw new ExtensionHostError('EXTENSION_UPDATE_ROLLED_BACK');
      }
      if (stagedPath) await this.#clearStagedManifest(binding, pending!);
      return this.#snapshot(binding, state);
    }
    const entry = state.entries.find((item) => item.manifest.id === input.id);
    need(entry && entry.integrity === input.integrity, 'EXTENSION_IDENTITY_CHANGED');
    if (input.action === 'start') {
      await this.#audit(binding, 'runtime.start', input.id, undefined, 'EXTENSION_SANDBOX_UNAVAILABLE');
      throw new ExtensionHostError('EXTENSION_SANDBOX_UNAVAILABLE'); // No executable-code loading or subprocess fallback.
    }
    if (input.action === 'rollback') {
      const prior = state.history.find((item) => item.manifest.id === input.id);
      if (!prior) throw new ExtensionHostError('EXTENSION_ROLLBACK_UNAVAILABLE');
      need(await this.options.confirm?.('Volver a la versión anterior', `${input.id}\n${entry!.manifest.version} → ${prior.manifest.version}\nLa versión restaurada queda desactivada y sin concesiones. Se preserva el contenido del proyecto y la versión actual queda disponible para volver a ella.`), 'EXTENSION_APPROVAL_REJECTED');
      need(authorityRevision === this.#authorityRevision, 'EXTENSION_REVIEW_STALE');
      this.#leases.invalidate(binding.root, binding.projectId, input.id);
      state.entries = state.entries.map((item) => item === entry ? { manifest: clone(prior.manifest), integrity: prior.integrity, disabled: true, approvals: {} } : item);
      state.history = [...state.history.filter((item) => item.manifest.id !== input.id), { manifest: clone(entry!.manifest), integrity: entry!.integrity }];
    } else if (input.action === 'grant') {
      need(subset(input.capability, entry!.manifest.scopes[input.capability], input.scope), 'EXTENSION_OUTSIDE_SCOPE');
      need(await this.options.confirm?.('Revisar concesión local de extensión', `${input.id}\nCapacidad: ${input.capability}\nScope: ${JSON.stringify(input.scope)}\nAprobación solo para este manifiesto y proyecto. Continúa INEFECTIVA mientras no haya sandbox comprobada y permiso efectivo del proyecto.`), 'EXTENSION_APPROVAL_REJECTED');
      need(authorityRevision === this.#authorityRevision, 'EXTENSION_REVIEW_STALE');
      this.#leases.invalidate(binding.root, binding.projectId, input.id);
      entry!.approvals[input.capability] = clone(input.scope);
    } else {
      this.#leases.invalidate(binding.root, binding.projectId, input.id);
      if (input.action === 'revoke') delete entry!.approvals[input.capability];
      if (input.action === 'disable') { entry!.disabled = true; entry!.approvals = {}; }
      if (input.action === 'remove') { state.entries = state.entries.filter((item) => item !== entry); state.history = state.history.filter((item) => item.manifest.id !== input.id); }
    }
    await this.#audit(binding, input.action, input.id, input.action === 'grant' || input.action === 'revoke' ? input.capability : undefined);
    await this.#save(binding, state, loaded.fingerprint); return this.#snapshot(binding, state);
  }
  handle(value: unknown): Promise<ExtensionsResult> {
    if (!validExtensionsRequest(value)) return Promise.resolve({ ok: false, error: { code: 'EXTENSION_INVALID_REQUEST', message: 'Solicitud de extensión inválida.', recovery: 'Usa el gestor local; no se aceptan rutas, actores ni proyectos suministrados por un plugin.' } });
    const input = clone(value);
    const task = this.#tail.catch(() => undefined).then(async (): Promise<ExtensionsResult> => {
      try { return { ok: true, value: await this.#execute(input) }; }
      catch (error) {
        const code = error instanceof ExtensionHostError ? error.code : 'EXTENSION_HOST_UNAVAILABLE';
        try {
          const binding = await this.#binding(input.sessionId);
          await this.#audit(binding, `denied.${input.action}`, 'id' in input ? input.id : undefined,
            input.action === 'grant' || input.action === 'revoke' ? input.capability : undefined, code);
        } catch { /* A denial remains closed when its project or audit is unavailable. */ }
        const message = code === 'EXTENSION_SANDBOX_UNAVAILABLE' ? 'La ejecución de extensiones está deshabilitada: Windows no dispone de un launcher aislado comprobado en A3.' :
          code === 'EXTENSION_UPDATE_ROLLED_BACK' ? 'Falló la activación de la actualización; se conservó la versión anterior.' :
          code === 'EXTENSION_STAGING_INTEGRITY_FAILED' ? 'El manifiesto cambió dentro de staging y no se activó.' : 'El host rechazó la operación de extensión.';
        return { ok: false, error: { code, message, recovery: 'Revisa manifiesto, scope, sesión y concesión local. Los datos del proyecto se conservan.' } };
      }
    }); this.#tail = task; return task;
  }
  invalidateSessions(): void { this.#authorityRevision++; this.#reviews.clear(); this.#leases.invalidate(); }
  async dispose(): Promise<void> { this.#closed = true; this.invalidateSessions(); this.#unsubscribe(); await this.#tail; await this.#leases.settle(); }
}

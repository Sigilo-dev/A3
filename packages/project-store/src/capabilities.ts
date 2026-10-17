import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Actor, AuthorizationRequest } from '@a3/domain';
import type { AccessRequest } from './service-types.js';

/** Capability names are stable policy identifiers; none are inferred from agent prompts. */
export const CAPABILITIES = [
  'project.read', 'mount.read', 'mount.index', 'mount.write', 'document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'process.run',
  'network.access', 'package.install', 'apps.connect', 'media.convert', 'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push',
  'git.branch', 'git.restore', 'export'
] as const;
export type Capability = typeof CAPABILITIES[number];
export type Profile = 'consultar' | 'proponer' | 'trabajar' | 'personalizado';
export type GrantMode = 'deny' | 'propose' | 'approval' | 'direct';
export type MountPermission = 'read-only' | 'read-write';
export type LocalMountCapability = 'index' | 'read' | 'write' | 'git';
export interface LocalMountCapabilities { index: boolean; read: boolean; write: boolean; git: boolean; }
export interface LocalMountBinding {
  mountId: string;
  projectId: string;
  /** Canonical host-local path. Never copy this field into a project document or renderer payload. */
  canonicalRoot: string;
  permission: MountPermission;
  /** Per-mount host grants. They are intersected with the project capability broker. */
  capabilities: LocalMountCapabilities;
  rootIdentity: string;
  status: 'available' | 'root-missing' | 'root-changed';
}
export interface CapabilityDecision {
  allowed: boolean;
  capability: Capability;
  missingCapability?: Capability;
  reason: 'granted' | 'profile-denied' | 'approval-required' | 'approval-rejected' | 'actor-mismatch' | 'capability-unavailable' | 'grant-unavailable' | 'audit-unavailable';
  mode: GrantMode;
}
export interface EffectiveCapabilityState {
  capability: Capability;
  effectiveMode: GrantMode;
  requestedMode?: GrantMode;
  available: boolean;
  reason: 'granted' | 'profile-denied' | 'approval-required' | 'capability-unavailable' | 'grant-unavailable';
}
export interface ProjectCapabilityState {
  /** An untrusted, portable request read from .a3/policies.json. */
  requestedProfile?: Profile;
  sharedRequestState: 'absent' | 'valid' | 'invalid';
  /** The profile approved and kept in host-local state for this project. */
  effectiveProfile: Profile;
  capabilities: readonly EffectiveCapabilityState[];
}
export interface CapabilityRevocation { root: string; projectId: string; capability: Capability; }
export interface CapabilityApprovalReview {
  tool: 'apply_changes' | 'undo_changes';
  affected: readonly { kind: 'entity'; id: string; expectedRevision: number; resultingRevision: number }[];
  diff: readonly { entityId: string; field: 'title' | 'tags'; before: string; after: string }[];
}
export interface ProjectCapabilityBroker {
  authorizeAccess(request: AccessRequest): CapabilityDecision;
  authorizeDomain(root: string, actor: Actor, request: AuthorizationRequest): CapabilityDecision;
  authorizeApply(root: string, actor: Actor, request: AuthorizationRequest, review?: CapabilityApprovalReview): Promise<CapabilityDecision>;
  authorizeCapabilities(root: string, actor: Actor, projectId: string, capabilities: readonly Capability[], operation: string, stage?: 'prepare' | 'apply'): Promise<CapabilityDecision>;
  getPolicyState(input: { root: string; projectId: string }): ProjectCapabilityState;
  subscribeRevocations(listener: (event: CapabilityRevocation) => void): () => void;
  setProfile(input: { root: string; projectId: string; profile?: Profile }): Promise<boolean>;
  setGrant(input: { root: string; projectId: string; capability: Capability; mode: GrantMode }): Promise<boolean>;
  revoke(input: { root: string; projectId: string; capability: Capability }): Promise<boolean>;
  approveLocalMount(input: { root: string; projectId: string; mountId: string; selectedRoot: string; permission: MountPermission }): Promise<boolean>;
  getLocalMount(input: { root: string; projectId: string; mountId: string }): LocalMountBinding | undefined;
  setLocalMountCapability(input: { root: string; projectId: string; mountId: string; capability: LocalMountCapability; granted: boolean }): Promise<boolean>;
  revokeLocalMount(input: { root: string; projectId: string; mountId: string }): Promise<boolean>;
}
export interface BrokerOptions {
  /** Host-local app data directory. It must be outside all project roots. */
  stateDirectory: string;
  /** Set only by the trusted main-process StoreHost constructor. */
  authenticatedActor: Actor;
  /** Main-process user confirmation callback. No callback means no interactive approvals. */
  confirmUserAction?: (input: { projectId: string; capability: Capability; operation: string; displayTarget?: string; review?: CapabilityApprovalReview }) => boolean | Promise<boolean>;
}
interface GrantFile { schemaVersion: '1.0.0'; rootKey: string; projectId: string; profile: Profile; overrides: Partial<Record<Capability, GrantMode>>; }
interface MountFile { schemaVersion: '1.0.0'; rootKey: string; projectId: string; mounts: Record<string, { canonicalRoot: string; permission: MountPermission; rootIdentity: string; capabilities?: LocalMountCapabilities }>; }
export interface SharedPolicyRequest { schemaVersion: '1.0.0'; profile?: Profile; requests: readonly { capability: Capability; mode: GrantMode }[]; }

export const CAPABILITY_GROUPS = [
  { id: 'read', label: 'Lectura', capabilities: ['project.read', 'mount.read', 'mount.index'] },
  { id: 'write', label: 'Escritura', capabilities: ['document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'mount.write'] },
  { id: 'shell', label: 'Procesos y shell', capabilities: ['process.run'] },
  { id: 'network', label: 'Red', capabilities: ['network.access'] },
  { id: 'git', label: 'Git', capabilities: ['git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'git.branch', 'git.restore'] },
  { id: 'apps', label: 'Aplicaciones', capabilities: ['apps.connect', 'package.install', 'media.convert', 'export'] }
] as const satisfies readonly { id: string; label: string; capabilities: readonly Capability[] }[];

const profileModes: Record<Profile, Partial<Record<Capability, GrantMode>>> = {
  consultar: { 'project.read': 'direct' },
  proponer: { 'project.read': 'direct', 'mount.index': 'approval', 'media.convert': 'approval', 'document.edit': 'approval', 'diagram.edit': 'approval', 'task.edit': 'approval', 'project.recover': 'approval', 'process.run': 'approval', 'network.access': 'approval', 'git.status': 'approval', 'git.diff': 'approval', 'git.stage': 'approval', 'git.commit': 'approval', 'git.push': 'approval', 'git.branch': 'approval', 'git.restore': 'approval', 'apps.connect': 'approval', 'package.install': 'approval', export: 'approval' },
  trabajar: { 'project.read': 'direct', 'mount.index': 'direct', 'media.convert': 'direct', 'document.edit': 'direct', 'diagram.edit': 'direct', 'task.edit': 'direct', 'project.recover': 'approval', 'process.run': 'direct', 'network.access': 'direct', 'git.status': 'direct', 'git.diff': 'direct', 'git.stage': 'approval', 'git.commit': 'approval', 'git.push': 'approval', 'git.branch': 'approval', 'git.restore': 'approval', 'apps.connect': 'approval', 'package.install': 'approval', export: 'direct' },
  personalizado: { 'project.read': 'deny' }
};
// E0-C2 did not verify OS process isolation, network confinement, package execution,
// or arbitrary helpers. Git is limited to fixed local commands (E6-A2) and the
// reviewed GitHub-only publishing transport (E6-B1), never generic network access.
const unavailable = new Set<Capability>([
  'mount.write', 'process.run', 'network.access', 'apps.connect', 'package.install'
]);
const known = new Set<string>(CAPABILITIES);
const trustedBrokers = new WeakSet<object>();
const domainRefCapabilities = new Set(['workspace', 'placement', 'visual-edge', 'relation-view', 'group', 'drawing', 'relation']);
const isProfile = (value: unknown): value is Profile => value === 'consultar' || value === 'proponer' || value === 'trabajar' || value === 'personalizado';
const isMode = (value: unknown): value is GrantMode => value === 'deny' || value === 'propose' || value === 'approval' || value === 'direct';
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function safeOperation(value: string): string {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (new RegExp(`^a3\\.core\\.[a-z-]+(?::${uuid})?$`, 'i').test(value)) return value.replace(new RegExp(`:${uuid}$`, 'i'), ':<operation-id>');
  if (new RegExp(`^a3\\.diagrams\\.[a-z-]+(?::${uuid})?$`, 'i').test(value)) return value.replace(new RegExp(`:${uuid}$`, 'i'), ':<operation-id>');
  if (new RegExp(`^a3\\.variables\\.[a-z-]+(?::${uuid})?$`, 'i').test(value)) return value.replace(new RegExp(`:${uuid}$`, 'i'), ':<operation-id>');
  if (/^policy\.profile:(consultar|proponer|trabajar|personalizado)$/.test(value)) return value;
  if (/^policy\.grant:(deny|propose|approval|direct)$/.test(value)) return value;
  if (/^mount\.bind:(read-only|read-write)$/.test(value)) return value;
  if (/^mount\.capability:(index|read|write|git):(grant|revoke)$/.test(value)) return value;
  if (value === 'mount.revoke') return value;
  if (value === 'policy.revoke') return value;
  if (value === 'media.convert') return value;
  if (value === 'github.publish') return value;
  if (/^git\.(status|diff|stage|commit|branch|restore)$/.test(value)) return value;
  for (const prefix of ['snapshot.create:', 'project.maintenance:', 'resource.write:', 'journal.recovery:']) {
    if (new RegExp(`^${prefix.replaceAll('.', '\\.')} ${uuid}$`.replace(' ', ''), 'i').test(value)) return `${prefix}<operation-id>`;
  }
  return 'host.operation';
}
function canonicalRoot(root: string): string { return realpathSync(resolve(root)).replaceAll('\\', '/').toLowerCase(); }
function validUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function statIdentity(stat: { dev: bigint; ino: bigint; mode: bigint }): string {
  if (stat.ino === 0n) throw new TypeError('El sistema de archivos no ofrece una identidad estable para el montaje.');
  return stat.dev.toString(16) + ':' + stat.ino.toString(16) + ':' + (stat.mode & 0o170000n).toString(16);
}
function isMountPermission(value: unknown): value is MountPermission { return value === 'read-only' || value === 'read-write'; }
function validMountCapabilities(value: unknown): value is LocalMountCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => ['index', 'read', 'write', 'git'].includes(key)) &&
    ['index', 'read', 'write', 'git'].every((key) => typeof item[key] === 'boolean') && item.write === false;
}
const defaultMountCapabilities = (): LocalMountCapabilities => ({ index: false, read: true, write: false, git: false });
function mountAuditCapability(capability: LocalMountCapability): Capability {
  return capability === 'index' ? 'mount.index' : capability === 'read' ? 'mount.read' : capability === 'write' ? 'mount.write' : 'git.status';
}
function rootKey(root: string): string { return hash(canonicalRoot(root)); }
function decision(capability: Capability, mode: GrantMode, reason: CapabilityDecision['reason'], allowed = false): CapabilityDecision {
  return { allowed, capability, ...(!allowed && reason !== 'audit-unavailable' ? { missingCapability: capability } : {}), reason, mode };
}
function profileMode(grant: GrantFile, capability: Capability): GrantMode { return grant.overrides[capability] ?? profileModes[grant.profile][capability] ?? 'deny'; }
const modeRank: Record<GrantMode, number> = { deny: 0, propose: 1, approval: 2, direct: 3 };
function validateGrant(value: unknown, expectedRoot: string, projectId: string): GrantFile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Partial<GrantFile>;
  if (v.schemaVersion !== '1.0.0' || v.rootKey !== expectedRoot || v.projectId !== projectId || !isProfile(v.profile) || !v.overrides || typeof v.overrides !== 'object' || Array.isArray(v.overrides)) return undefined;
  const overrides: Partial<Record<Capability, GrantMode>> = {};
  for (const [key, mode] of Object.entries(v.overrides)) {
    if (!known.has(key) || !isMode(mode)) return undefined;
    overrides[key as Capability] = mode;
  }
  return { schemaVersion: '1.0.0', rootKey: expectedRoot, projectId, profile: v.profile, overrides };
}

/** Parse shared policy as an inert request document. The broker never loads it as a grant. */
export function parseSharedPolicyRequest(input: string | unknown): SharedPolicyRequest | undefined {
  let value: unknown = input;
  if (typeof input === 'string') { try { value = JSON.parse(input); } catch { return undefined; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as { schemaVersion?: unknown; profile?: unknown; requests?: unknown };
  if (object.schemaVersion !== '1.0.0' || !Array.isArray(object.requests)) return undefined;
  if (object.profile !== undefined && !isProfile(object.profile)) return undefined;
  const requests: { capability: Capability; mode: GrantMode }[] = [];
  for (const item of object.requests) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const candidate = item as { capability?: unknown; mode?: unknown };
    if (typeof candidate.capability !== 'string' || !known.has(candidate.capability) || !isMode(candidate.mode)) return undefined;
    requests.push({ capability: candidate.capability as Capability, mode: candidate.mode });
  }
  return { schemaVersion: '1.0.0', ...(object.profile ? { profile: object.profile } : {}), requests };
}

export function isProjectCapabilityBroker(value: unknown): value is ProjectCapabilityBroker {
  return !!value && typeof value === 'object' && trustedBrokers.has(value);
}

export function createProjectCapabilityBroker(options: BrokerOptions): ProjectCapabilityBroker {
  const state = resolve(options.stateDirectory);
  mkdirSync(state, { recursive: true });
  const realState = realpathSync(state);
  const grantsRoot = join(state, 'project-capabilities');
  const mountsRoot = join(state, 'project-mounts');
  const auditPath = join(state, 'capability-audit.ndjson');
  const assertStateOutside = (root: string): string => {
    const canonical = canonicalRoot(root);
    const relativeState = relative(canonical, realState);
    if (relativeState === '' || relativeState !== '..' && !relativeState.startsWith(`..${sep}`) && !relativeState.startsWith('../')) {
      throw new TypeError('La concesión local debe almacenarse fuera de la carpeta del proyecto.');
    }
    return canonical;
  };
  const localFor = (root: string, projectId: string): { key: string; path: string } => {
    const canonical = assertStateOutside(root);
    const key = hash(canonical);
    if (!validUuid(projectId)) throw new TypeError('projectId inválido');
    return { key, path: join(grantsRoot, key, `${projectId.toLowerCase()}.json`) };
  };
  const readGrant = (root: string, projectId: string): GrantFile | undefined => {
    try {
      assertStateOutside(root);
      const location = localFor(root, projectId);
      return validateGrant(JSON.parse(readFileSync(location.path, 'utf8')), location.key, projectId.toLowerCase());
    } catch { return undefined; }
  };
  const readSharedRequest = (root: string, projectId: string): { state: ProjectCapabilityState['sharedRequestState']; policy?: SharedPolicyRequest } => {
    try {
      if (!validUuid(projectId)) return { state: 'invalid' };
      const canonical = realpathSync.native(resolve(root));
      const path = join(canonical, '.a3', 'policies.json');
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync.native(path).toLowerCase() !== path.toLowerCase() || stat.size > 64 * 1024) return { state: 'invalid' };
      const parsed = parseSharedPolicyRequest(readFileSync(path, 'utf8'));
      return parsed ? { state: 'valid', policy: parsed } : { state: 'invalid' };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
    }
  };
  const mountLocation = (root: string, projectId: string): { key: string; path: string } => {
    const canonical = assertStateOutside(root);
    if (!validUuid(projectId)) throw new TypeError('projectId inválido');
    const key = hash(canonical);
    return { key, path: join(mountsRoot, key, projectId.toLowerCase() + '.json') };
  };
  const readMountFile = (root: string, projectId: string): MountFile | undefined => {
    try {
      const location = mountLocation(root, projectId);
      const value = JSON.parse(readFileSync(location.path, 'utf8')) as Partial<MountFile>;
      if (value.schemaVersion !== '1.0.0' || value.rootKey !== location.key || value.projectId !== projectId.toLowerCase() ||
          !value.mounts || typeof value.mounts !== 'object' || Array.isArray(value.mounts)) return undefined;
      const mounts: MountFile['mounts'] = {};
      for (const [mountId, binding] of Object.entries(value.mounts)) {
        if (!validUuid(mountId) || !binding || typeof binding !== 'object' || !isMountPermission(binding.permission) ||
            typeof binding.canonicalRoot !== 'string' || !isAbsolute(binding.canonicalRoot) ||
            process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(binding.canonicalRoot) ||
            typeof binding.rootIdentity !== 'string' || !/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(binding.rootIdentity) ||
            binding.capabilities !== undefined && !validMountCapabilities(binding.capabilities)) return undefined;
        mounts[mountId.toLowerCase()] = { canonicalRoot: binding.canonicalRoot, permission: binding.permission, rootIdentity: binding.rootIdentity,
          capabilities: binding.capabilities ?? defaultMountCapabilities() };
      }
      return { schemaVersion: '1.0.0', rootKey: location.key, projectId: projectId.toLowerCase(), mounts };
    } catch { return undefined; }
  };
  const persistMounts = (value: MountFile, path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  };
  const currentMount = (input: { root: string; projectId: string; mountId: string }): LocalMountBinding | undefined => {
    if (!validUuid(input.mountId)) return undefined;
    const file = readMountFile(input.root, input.projectId);
    const mount = file?.mounts[input.mountId.toLowerCase()];
    if (!mount || !file) return undefined;
    let status: LocalMountBinding['status'] = 'available';
    try {
      const currentReal = realpathSync.native(mount.canonicalRoot).replaceAll('\\', '/');
      const stat = lstatSync(mount.canonicalRoot, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() ||
          currentReal.toLowerCase() !== mount.canonicalRoot.replaceAll('\\', '/').toLowerCase() ||
          statIdentity(stat) !== mount.rootIdentity) status = 'root-changed';
    } catch (error) {
      status = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'root-missing' : 'root-changed';
    }
    return { mountId: input.mountId.toLowerCase(), projectId: input.projectId.toLowerCase(), ...mount,
      capabilities: mount.capabilities ?? defaultMountCapabilities(), status };
  };
  const persist = (grant: GrantFile, path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(grant, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  };
  const audit = (input: { root: string; projectId?: string; actor: Actor; operation: string; capability: Capability; allowed: boolean; reason: CapabilityDecision['reason'] }): boolean => {
    try {
      mkdirSync(state, { recursive: true });
      const row = { schemaVersion: '1.0.0', at: new Date().toISOString(), projectKey: rootKey(input.root),
        ...(input.projectId ? { projectKeyId: hash(input.projectId.toLowerCase()) } : {}), actorKind: input.actor.kind,
        operation: safeOperation(input.operation), capability: input.capability, outcome: input.allowed ? 'allow' : 'deny', reason: input.reason };
      appendFileSync(auditPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch { return false; }
  };
  const audited = (root: string, projectId: string | undefined, actor: Actor, operation: string, capability: Capability, mode: GrantMode,
    reason: CapabilityDecision['reason'], allowed = false): CapabilityDecision => {
    return audit({ root, ...(projectId ? { projectId } : {}), actor, operation, capability, allowed, reason })
      ? decision(capability, mode, reason, allowed) : decision(capability, mode, 'audit-unavailable');
  };
  const actorMatches = (actor: Actor): boolean => !!actor && actor.kind === hostActor.kind && actor.id === hostActor.id;
  const hostActor: Actor = Object.freeze({ ...options.authenticatedActor });
  const humanActor: Actor = Object.freeze({ kind: 'user', id: 'local-user' });
  const revocationListeners = new Set<(event: CapabilityRevocation) => void>();
  const emitRevocation = (root: string, projectId: string, capability: Capability): void => {
    const event = Object.freeze({ root: canonicalRoot(root), projectId: projectId.toLowerCase(), capability });
    for (const listener of revocationListeners) { try { listener(event); } catch { /* Cancellation hooks cannot corrupt a grant update. */ } }
  };
  const authorizeOne = async (root: string, actor: Actor, projectId: string, capability: Capability, operation: string, stage: 'prepare' | 'apply', review?: CapabilityApprovalReview): Promise<CapabilityDecision> => {
    if (!actorMatches(actor)) return audited(root, projectId, actor, operation, capability, 'deny', 'actor-mismatch');
    const grant = readGrant(root, projectId);
    if (!grant) return audited(root, projectId, actor, operation, capability, 'deny', 'grant-unavailable');
    const mode = profileMode(grant, capability);
    if (unavailable.has(capability)) return audited(root, projectId, actor, operation, capability, mode, 'capability-unavailable');
    if (mode === 'deny') return audited(root, projectId, actor, operation, capability, mode, 'profile-denied');
    if (stage === 'prepare' || mode === 'direct') {
      return audited(root, projectId, actor, operation, capability, mode, 'granted', true);
    }
    if (mode === 'propose') {
      return audited(root, projectId, actor, operation, capability, mode, 'profile-denied');
    }
    let approved = false;
    try { approved = await options.confirmUserAction?.({ projectId, capability, operation: safeOperation(operation), ...(review ? { review } : {}) }) === true; } catch { /* No UI response denies. */ }
    const reason: CapabilityDecision['reason'] = approved ? 'granted' : options.confirmUserAction ? 'approval-rejected' : 'approval-required';
    return audited(root, projectId, actor, operation, capability, mode, reason, approved);
  };
  const modesForRequest = (request: AuthorizationRequest): Capability[] => {
    const caps = new Set<Capability>();
    if (request.command === 'a3.diagrams.set-style') caps.add('diagram.edit');
    else if (request.command === 'a3.core.register-node-type' || request.command === 'a3.core.unregister-node-type' || request.registryWrite) caps.add('package.install');
    else if (request.command === 'a3.core.delete') {
      caps.add('delete');
      caps.add(request.refs.some((ref) => domainRefCapabilities.has(ref.kind)) ? 'diagram.edit' : 'document.edit');
    } else if (request.command === 'a3.core.set-collection-members') {
      caps.add('task.edit');
    } else {
      if (request.changes.some((change) => !change.after) || request.contentEffects.some((effect) => effect.kind === 'remove')) caps.add('delete');
      if (request.refs.some((ref) => domainRefCapabilities.has(ref.kind)) || request.changes.some((change) => change.ref && domainRefCapabilities.has(change.ref.kind))) caps.add('diagram.edit');
      if (!caps.size || request.changes.some((change) => change.ref && !domainRefCapabilities.has(change.ref.kind)) || request.contentEffects.length) caps.add('document.edit');
    }
    const planning = request.changes.filter((change) => [change.before, change.after].some((record) => record?.kind === 'entity' && record.value.type.startsWith('a3.planning.')));
    if (request.command.startsWith('a3.planning.') || planning.length) {
      caps.add('task.edit');
      if (!request.contentEffects.length && (request.command === 'a3.planning.set-policy' || request.changes.every((change) => planning.includes(change)))) caps.delete('document.edit');
    }
    return [...caps];
  };
  const authorizeDomain = (root: string, actor: Actor, request: AuthorizationRequest): CapabilityDecision => {
      const caps = modesForRequest(request);
      for (const capability of caps) {
        const grant = readGrant(root, request.projectId);
        const mode = grant ? profileMode(grant, capability) : 'deny';
        if (!actorMatches(actor) || !actorMatches(request.actor)) return audited(root, request.projectId, actor, request.command, capability, mode, 'actor-mismatch');
        if (unavailable.has(capability)) return audited(root, request.projectId, actor, request.command, capability, mode, 'capability-unavailable');
        if (mode === 'deny') return audited(root, request.projectId, actor, request.command, capability, mode, grant ? 'profile-denied' : 'grant-unavailable');
        const allow = audited(root, request.projectId, actor, request.command, capability, mode, 'granted', true);
        if (!allow.allowed) return allow;
      }
      return { allowed: true, capability: caps[0] ?? 'document.edit', reason: 'granted', mode: caps.length ? (readGrant(root, request.projectId) ? profileMode(readGrant(root, request.projectId)!, caps[0]!) : 'deny') : 'deny' };
  };
  const broker = {
    authorizeAccess(request: AccessRequest): CapabilityDecision {
      const actor = request.actor;
      try { assertStateOutside(request.root); } catch { return decision('project.read', 'deny', 'grant-unavailable'); }
      let capability: Capability;
      if (request.operation === 'open-project') capability = 'project.read';
      else if (request.operation === 'read-resource') {
        const resource = request.resources[0];
        capability = resource?.kind === 'mounted-file' ? 'mount.read' : resource?.kind === 'remote-url' ? 'network.access' : 'project.read';
      } else capability = request.requiredCapabilities?.[0] ?? 'document.edit';
      const projectId = request.projectId?.toLowerCase();
      if (!projectId) return audited(request.root, undefined, actor, request.operation, capability, 'deny', 'grant-unavailable');
      const required = request.operation === 'write' && request.requiredCapabilities?.length ? [...request.requiredCapabilities] : [capability];
      const localMountCapability: LocalMountCapability | undefined = request.operation === 'read-resource' && request.resources.some((resource) => resource.kind === 'mounted-file')
        ? 'read' : required.includes('mount.index') ? 'index' : required.includes('mount.write') ? 'write' : undefined;
      if (localMountCapability && request.resources.some((resource) => resource.kind === 'mounted-file')) {
        for (const resource of request.resources) {
          if (resource.kind !== 'mounted-file') continue;
          const binding = currentMount({ root: request.root, projectId, mountId: resource.mountId });
          // Missing or moved roots are diagnosed by the host path resolver; this broker guard only enforces an explicit per-mount capability.
          if (binding && !binding.capabilities[localMountCapability]) {
            const deniedCapability = mountAuditCapability(localMountCapability);
            const grant = readGrant(request.root, projectId), mode = grant ? profileMode(grant, deniedCapability) : 'deny';
            return audited(request.root, projectId, actor, request.operation, deniedCapability, mode, 'grant-unavailable');
          }
        }
      }
      let lastMode: GrantMode = 'deny';
      for (const requiredCapability of required) {
        const grant = readGrant(request.root, projectId);
        const mode = grant ? profileMode(grant, requiredCapability) : 'deny'; lastMode = mode;
        let reason: CapabilityDecision['reason'] = !actorMatches(actor) ? 'actor-mismatch' : unavailable.has(requiredCapability) ? 'capability-unavailable' : mode === 'deny' ? grant ? 'profile-denied' : 'grant-unavailable' : 'granted';
        if (reason === 'granted' && request.operation === 'write' && request.stage === 'apply' && mode !== 'direct') {
          reason = mode === 'approval' ? 'approval-required' : 'profile-denied';
        }
        const allowed = reason === 'granted';
        const result = audited(request.root, projectId, actor, request.operation, requiredCapability, mode, reason, allowed);
        if (!result.allowed) return result;
      }
      return { allowed: true, capability: required[0] ?? capability, reason: 'granted', mode: lastMode };
    },
    authorizeDomain(root: string, actor: Actor, request: AuthorizationRequest): CapabilityDecision {
      const result = authorizeDomain(root, actor, request);
      if (result.reason === 'actor-mismatch' && !audit({ root, projectId: request.projectId, actor, operation: request.command,
        capability: result.capability, allowed: false, reason: result.reason })) return decision(result.capability, result.mode, 'audit-unavailable');
      return result;
    },
    async authorizeApply(root: string, actor: Actor, request: AuthorizationRequest, review?: CapabilityApprovalReview): Promise<CapabilityDecision> {
      const caps = modesForRequest(request);
      let lastMode: GrantMode = 'deny';
      for (const capability of caps) {
        const result = await authorizeOne(root, actor, request.projectId, capability, `${request.command}:${request.operationId ?? 'unidentified'}`, 'apply', review);
        if (!result.allowed) return result;
        lastMode = result.mode;
      }
      return { allowed: true, capability: caps[0] ?? 'document.edit', reason: 'granted', mode: lastMode };
    },
    async authorizeCapabilities(root: string, actor: Actor, projectId: string, capabilities: readonly Capability[], operation: string, stage: 'prepare' | 'apply' = 'apply'): Promise<CapabilityDecision> {
      let lastMode: GrantMode = 'deny';
      for (const capability of capabilities) {
        const result = await authorizeOne(root, actor, projectId, capability, operation, stage);
        if (!result.allowed) return result;
        lastMode = result.mode;
      }
      return { allowed: true, capability: capabilities[0] ?? 'document.edit', reason: 'granted', mode: lastMode };
    },
    getPolicyState(input: { root: string; projectId: string }): ProjectCapabilityState {
      const grant = readGrant(input.root, input.projectId);
      const shared = readSharedRequest(input.root, input.projectId);
      const requestedMode = (capability: Capability): GrantMode | undefined => {
        if (!shared.policy) return undefined;
        return shared.policy.requests.find((request) => request.capability === capability)?.mode ??
          (shared.policy.profile ? profileModes[shared.policy.profile][capability] : undefined);
      };
      return {
        ...(shared.policy?.profile ? { requestedProfile: shared.policy.profile } : {}),
        sharedRequestState: shared.state,
        effectiveProfile: grant?.profile ?? 'personalizado',
        capabilities: CAPABILITIES.map((capability) => {
          const effectiveMode = grant ? profileMode(grant, capability) : 'deny';
          const available = !unavailable.has(capability);
          const requested = requestedMode(capability);
          return { capability, effectiveMode, ...(requested ? { requestedMode: requested } : {}), available,
            reason: !grant ? 'grant-unavailable' : !available ? 'capability-unavailable' : effectiveMode === 'deny' || effectiveMode === 'propose' ? 'profile-denied' :
              effectiveMode === 'approval' ? 'approval-required' : 'granted' };
        })
      };
    },
    subscribeRevocations(listener: (event: CapabilityRevocation) => void): () => void {
      revocationListeners.add(listener); return () => { revocationListeners.delete(listener); };
    },
    async setProfile(input: { root: string; projectId: string; profile?: Profile }): Promise<boolean> {
      const profile = input.profile ?? 'proponer';
      if (!isProfile(profile) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: 'project.read', operation: safeOperation(`policy.profile:${profile}`), displayTarget: canonicalRoot(input.root) }))) return false;
      const target = localFor(input.root, input.projectId), old = readGrant(input.root, input.projectId);
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: `policy.profile:${profile}`, capability: 'project.read', allowed: true, reason: 'granted' })) return false;
      persist({ schemaVersion: '1.0.0', rootKey: target.key, projectId: input.projectId.toLowerCase(), profile, overrides: {} }, target.path);
      for (const capability of CAPABILITIES) {
        const before = old ? profileMode(old, capability) : 'deny', after = profileModes[profile][capability] ?? 'deny';
        if (modeRank[after] < modeRank[before]) emitRevocation(input.root, input.projectId, capability);
      }
      return true;
    },
    async setGrant(input: { root: string; projectId: string; capability: Capability; mode: GrantMode }): Promise<boolean> {
      if (!known.has(input.capability) || !isMode(input.mode) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: input.capability, operation: safeOperation(`policy.grant:${input.mode}`) }))) return false;
      const target = localFor(input.root, input.projectId); const old = readGrant(input.root, input.projectId);
      const next: GrantFile = old ?? { schemaVersion: '1.0.0', rootKey: target.key, projectId: input.projectId.toLowerCase(), profile: 'personalizado', overrides: {} };
      const previousMode = old ? profileMode(old, input.capability) : 'deny';
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: `policy.grant:${input.mode}`, capability: input.capability, allowed: true, reason: 'granted' })) return false;
      next.overrides[input.capability] = input.mode; persist(next, target.path);
      if (modeRank[input.mode] < modeRank[previousMode]) emitRevocation(input.root, input.projectId, input.capability);
      return true;
    },
    async revoke(input: { root: string; projectId: string; capability: Capability }): Promise<boolean> {
      if (!known.has(input.capability) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: input.capability, operation: safeOperation('policy.revoke') }))) return false;
      const target = localFor(input.root, input.projectId); const old = readGrant(input.root, input.projectId);
      if (!old || !known.has(input.capability)) return false;
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: 'policy.revoke', capability: input.capability, allowed: true, reason: 'granted' })) return false;
      old.overrides[input.capability] = 'deny'; persist(old, target.path);
      emitRevocation(input.root, input.projectId, input.capability);
      return true;
    },
    async approveLocalMount(input: { root: string; projectId: string; mountId: string; selectedRoot: string; permission: MountPermission }): Promise<boolean> {
      if (process.platform !== 'win32' || !validUuid(input.projectId) || !validUuid(input.mountId) || !isMountPermission(input.permission)) return false;
      let canonical: string; let identity: string;
      try {
        canonical = realpathSync.native(resolve(input.selectedRoot)).replaceAll('\\', '/');
        if (!/^[a-z]:\//i.test(canonical) || canonical.startsWith('//')) return false;
        const stat = lstatSync(canonical, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory() ||
            realpathSync.native(canonical).replaceAll('\\', '/').toLowerCase() !== canonical.toLowerCase()) return false;
        identity = statIdentity(stat);
      } catch { return false; }
      const capability: Capability = input.permission === 'read-write' ? 'mount.write' : 'mount.read';
      const operation = safeOperation('mount.bind:' + input.permission);
      let approved = false;
      try {
        approved = await options.confirmUserAction?.({ projectId: input.projectId, capability, operation, displayTarget: canonical }) === true;
      } catch { /* No UI response denies. */ }
      if (!approved) return false;
      try {
        const stat = lstatSync(canonical, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory() || statIdentity(stat) !== identity ||
            realpathSync.native(canonical).replaceAll('\\', '/').toLowerCase() !== canonical.toLowerCase()) return false;
      } catch { return false; }
      const target = mountLocation(input.root, input.projectId);
      const old = readMountFile(input.root, input.projectId);
      const next: MountFile = old ?? { schemaVersion: '1.0.0', rootKey: target.key, projectId: input.projectId.toLowerCase(), mounts: {} };
      const prior = next.mounts[input.mountId.toLowerCase()];
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation, capability, allowed: true, reason: 'granted' })) return false;
      const sameRoot = !!prior && prior.rootIdentity === identity && prior.canonicalRoot.toLowerCase() === canonical.toLowerCase();
      next.mounts[input.mountId.toLowerCase()] = { canonicalRoot: canonical, permission: input.permission, rootIdentity: identity,
        capabilities: sameRoot ? { ...(prior.capabilities ?? defaultMountCapabilities()), read: true, write: false } : defaultMountCapabilities() };
      persistMounts(next, target.path);
      return true;
    },
    getLocalMount(input: { root: string; projectId: string; mountId: string }): LocalMountBinding | undefined {
      try { return currentMount(input); } catch { return undefined; }
    },
    async setLocalMountCapability(input: { root: string; projectId: string; mountId: string; capability: LocalMountCapability; granted: boolean }): Promise<boolean> {
      if (!validUuid(input.projectId) || !validUuid(input.mountId) || !['index', 'read', 'write', 'git'].includes(input.capability) ||
          typeof input.granted !== 'boolean' || input.capability === 'write' && input.granted) return false;
      const target = mountLocation(input.root, input.projectId), old = readMountFile(input.root, input.projectId);
      const mount = old?.mounts[input.mountId.toLowerCase()]; if (!old || !mount) return false;
      const current = currentMount({ root: input.root, projectId: input.projectId, mountId: input.mountId });
      if (!current || input.granted && current.status !== 'available') return false;
      const capabilities = { ...(mount.capabilities ?? defaultMountCapabilities()) };
      if (capabilities[input.capability] === input.granted) return true;
      const projectCapability = mountAuditCapability(input.capability), operation = safeOperation(`mount.capability:${input.capability}:${input.granted ? 'grant' : 'revoke'}`);
      let approved = false;
      try { approved = await options.confirmUserAction?.({ projectId: input.projectId, capability: projectCapability, operation, displayTarget: mount.canonicalRoot }) === true; }
      catch { /* No UI response denies. */ }
      if (!approved) return false;
      const observed = currentMount({ root: input.root, projectId: input.projectId, mountId: input.mountId });
      if (!observed || input.granted && observed.status !== 'available' || observed.rootIdentity !== current.rootIdentity ||
          observed.canonicalRoot.toLowerCase() !== current.canonicalRoot.toLowerCase()) return false;
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation, capability: projectCapability, allowed: true, reason: 'granted' })) return false;
      capabilities[input.capability] = input.granted;
      mount.capabilities = capabilities;
      persistMounts(old, target.path);
      return true;
    },
    async revokeLocalMount(input: { root: string; projectId: string; mountId: string }): Promise<boolean> {
      if (!validUuid(input.projectId) || !validUuid(input.mountId) || !options.confirmUserAction ||
          !(await options.confirmUserAction({ projectId: input.projectId, capability: 'mount.read', operation: safeOperation('mount.revoke') }))) return false;
      const target = mountLocation(input.root, input.projectId);
      const old = readMountFile(input.root, input.projectId);
      if (!old || !old.mounts[input.mountId.toLowerCase()]) return false;
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: 'mount.revoke', capability: 'mount.read', allowed: true, reason: 'granted' })) return false;
      delete old.mounts[input.mountId.toLowerCase()];
      persistMounts(old, target.path);
      return true;
    }
  } as ProjectCapabilityBroker;
  const sealed = Object.freeze(broker);
  trustedBrokers.add(sealed);
  return sealed;
}

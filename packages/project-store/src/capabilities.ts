import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Actor, AuthorizationRequest } from '@a3/domain';
import type { AccessRequest } from './service-types.js';

/** Capability names are stable policy identifiers; none are inferred from agent prompts. */
export const CAPABILITIES = [
  'project.read', 'mount.read', 'document.edit', 'diagram.edit', 'task.edit', 'delete', 'project.recover', 'process.run',
  'network.access', 'package.install', 'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push',
  'git.branch', 'git.restore', 'export'
] as const;
export type Capability = typeof CAPABILITIES[number];
export type Profile = 'consultar' | 'proponer' | 'trabajar' | 'personalizado';
export type GrantMode = 'deny' | 'propose' | 'approval' | 'direct';
export interface CapabilityDecision {
  allowed: boolean;
  capability: Capability;
  missingCapability?: Capability;
  reason: 'granted' | 'profile-denied' | 'approval-required' | 'approval-rejected' | 'actor-mismatch' | 'capability-unavailable' | 'grant-unavailable' | 'audit-unavailable';
  mode: GrantMode;
}
export interface ProjectCapabilityBroker {
  authorizeAccess(request: AccessRequest): CapabilityDecision;
  authorizeDomain(root: string, actor: Actor, request: AuthorizationRequest): CapabilityDecision;
  authorizeApply(root: string, actor: Actor, request: AuthorizationRequest): Promise<CapabilityDecision>;
  authorizeCapabilities(root: string, actor: Actor, projectId: string, capabilities: readonly Capability[], operation: string, stage?: 'prepare' | 'apply'): Promise<CapabilityDecision>;
  setProfile(input: { root: string; projectId: string; profile?: Profile }): Promise<boolean>;
  setGrant(input: { root: string; projectId: string; capability: Capability; mode: GrantMode }): Promise<boolean>;
  revoke(input: { root: string; projectId: string; capability: Capability }): Promise<boolean>;
}
export interface BrokerOptions {
  /** Host-local app data directory. It must be outside all project roots. */
  stateDirectory: string;
  /** Set only by the trusted main-process StoreHost constructor. */
  authenticatedActor: Actor;
  /** Main-process user confirmation callback. No callback means no interactive approvals. */
  confirmUserAction?: (input: { projectId: string; capability: Capability; operation: string }) => boolean | Promise<boolean>;
}
interface GrantFile { schemaVersion: '1.0.0'; rootKey: string; projectId: string; profile: Profile; overrides: Partial<Record<Capability, GrantMode>>; }
export interface SharedPolicyRequest { schemaVersion: '1.0.0'; requests: readonly { capability: Capability; mode: GrantMode }[]; }

const profileModes: Record<Profile, Partial<Record<Capability, GrantMode>>> = {
  consultar: { 'project.read': 'direct' },
  proponer: { 'project.read': 'direct', 'document.edit': 'approval', 'diagram.edit': 'approval', 'task.edit': 'approval', 'project.recover': 'approval' },
  trabajar: { 'project.read': 'direct', 'document.edit': 'direct', 'diagram.edit': 'direct', 'task.edit': 'direct', 'project.recover': 'approval' },
  personalizado: { 'project.read': 'deny' }
};
// E0-C2 did not verify OS process isolation, network confinement, package execution,
// Git, or export adapters. A local policy cannot turn an absent enforcement boundary on.
const unavailable = new Set<Capability>([
  'process.run', 'network.access', 'package.install', 'git.status', 'git.diff', 'git.stage', 'git.commit',
  'git.push', 'git.branch', 'git.restore', 'export'
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
  if (/^policy\.profile:(consultar|proponer|trabajar|personalizado)$/.test(value)) return value;
  if (/^policy\.grant:(deny|propose|approval|direct)$/.test(value)) return value;
  if (value === 'policy.revoke') return value;
  for (const prefix of ['snapshot.create:', 'project.maintenance:', 'resource.write:', 'journal.recovery:']) {
    if (new RegExp(`^${prefix.replaceAll('.', '\\.')} ${uuid}$`.replace(' ', ''), 'i').test(value)) return `${prefix}<operation-id>`;
  }
  return 'host.operation';
}
function canonicalRoot(root: string): string { return realpathSync(resolve(root)).replaceAll('\\', '/').toLowerCase(); }
function rootKey(root: string): string { return hash(canonicalRoot(root)); }
function decision(capability: Capability, mode: GrantMode, reason: CapabilityDecision['reason'], allowed = false): CapabilityDecision {
  return { allowed, capability, ...(!allowed && reason !== 'audit-unavailable' ? { missingCapability: capability } : {}), reason, mode };
}
function profileMode(grant: GrantFile, capability: Capability): GrantMode { return grant.overrides[capability] ?? profileModes[grant.profile][capability] ?? 'deny'; }
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
  const object = value as { schemaVersion?: unknown; requests?: unknown };
  if (object.schemaVersion !== '1.0.0' || !Array.isArray(object.requests)) return undefined;
  const requests: { capability: Capability; mode: GrantMode }[] = [];
  for (const item of object.requests) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const candidate = item as { capability?: unknown; mode?: unknown };
    if (typeof candidate.capability !== 'string' || !known.has(candidate.capability) || !isMode(candidate.mode)) return undefined;
    requests.push({ capability: candidate.capability as Capability, mode: candidate.mode });
  }
  return { schemaVersion: '1.0.0', requests };
}

export function isProjectCapabilityBroker(value: unknown): value is ProjectCapabilityBroker {
  return !!value && typeof value === 'object' && trustedBrokers.has(value);
}

export function createProjectCapabilityBroker(options: BrokerOptions): ProjectCapabilityBroker {
  const state = resolve(options.stateDirectory);
  mkdirSync(state, { recursive: true });
  const realState = realpathSync(state);
  const grantsRoot = join(state, 'project-capabilities');
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
    if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) throw new TypeError('projectId inválido');
    return { key, path: join(grantsRoot, key, `${projectId.toLowerCase()}.json`) };
  };
  const readGrant = (root: string, projectId: string): GrantFile | undefined => {
    try {
      assertStateOutside(root);
      const location = localFor(root, projectId);
      return validateGrant(JSON.parse(readFileSync(location.path, 'utf8')), location.key, projectId.toLowerCase());
    } catch { return undefined; }
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
  const authorizeOne = async (root: string, actor: Actor, projectId: string, capability: Capability, operation: string, stage: 'prepare' | 'apply'): Promise<CapabilityDecision> => {
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
    try { approved = await options.confirmUserAction?.({ projectId, capability, operation: safeOperation(operation) }) === true; } catch { /* No UI response denies. */ }
    const reason: CapabilityDecision['reason'] = approved ? 'granted' : options.confirmUserAction ? 'approval-rejected' : 'approval-required';
    return audited(root, projectId, actor, operation, capability, mode, reason, approved);
  };
  const modesForRequest = (request: AuthorizationRequest): Capability[] => {
    const caps = new Set<Capability>();
    if (request.command === 'a3.core.register-node-type' || request.command === 'a3.core.unregister-node-type' || request.registryWrite) caps.add('package.install');
    else if (request.command === 'a3.core.delete') {
      caps.add('delete');
      caps.add(request.refs.some((ref) => domainRefCapabilities.has(ref.kind)) ? 'diagram.edit' : 'document.edit');
    } else if (request.command === 'a3.core.set-collection-members') {
      caps.add('task.edit');
    } else {
      if (request.refs.some((ref) => domainRefCapabilities.has(ref.kind)) || request.changes.some((change) => change.ref && domainRefCapabilities.has(change.ref.kind))) caps.add('diagram.edit');
      if (!caps.size || request.changes.some((change) => change.ref && !domainRefCapabilities.has(change.ref.kind)) || request.contentEffects.length) caps.add('document.edit');
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
    async authorizeApply(root: string, actor: Actor, request: AuthorizationRequest): Promise<CapabilityDecision> {
      const caps = modesForRequest(request);
      for (const capability of caps) {
        const result = await authorizeOne(root, actor, request.projectId, capability, `${request.command}:${request.operationId ?? 'unidentified'}`, 'apply');
        if (!result.allowed) return result;
      }
      return { allowed: true, capability: caps[0] ?? 'document.edit', reason: 'granted', mode: 'direct' };
    },
    async authorizeCapabilities(root: string, actor: Actor, projectId: string, capabilities: readonly Capability[], operation: string, stage: 'prepare' | 'apply' = 'apply'): Promise<CapabilityDecision> {
      for (const capability of capabilities) {
        const result = await authorizeOne(root, actor, projectId, capability, operation, stage);
        if (!result.allowed) return result;
      }
      return { allowed: true, capability: capabilities[0] ?? 'document.edit', reason: 'granted', mode: 'direct' };
    },
    async setProfile(input: { root: string; projectId: string; profile?: Profile }): Promise<boolean> {
      const profile = input.profile ?? 'proponer';
      if (!isProfile(profile) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: 'project.read', operation: safeOperation(`policy.profile:${profile}`) }))) return false;
      const target = localFor(input.root, input.projectId);
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: `policy.profile:${profile}`, capability: 'project.read', allowed: true, reason: 'granted' })) return false;
      persist({ schemaVersion: '1.0.0', rootKey: target.key, projectId: input.projectId.toLowerCase(), profile, overrides: {} }, target.path);
      return true;
    },
    async setGrant(input: { root: string; projectId: string; capability: Capability; mode: GrantMode }): Promise<boolean> {
      if (!known.has(input.capability) || !isMode(input.mode) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: input.capability, operation: safeOperation(`policy.grant:${input.mode}`) }))) return false;
      const target = localFor(input.root, input.projectId); const old = readGrant(input.root, input.projectId);
      const next: GrantFile = old ?? { schemaVersion: '1.0.0', rootKey: target.key, projectId: input.projectId.toLowerCase(), profile: 'personalizado', overrides: {} };
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: `policy.grant:${input.mode}`, capability: input.capability, allowed: true, reason: 'granted' })) return false;
      next.overrides[input.capability] = input.mode; persist(next, target.path);
      return true;
    },
    async revoke(input: { root: string; projectId: string; capability: Capability }): Promise<boolean> {
      if (!known.has(input.capability) || !options.confirmUserAction || !(await options.confirmUserAction({ projectId: input.projectId, capability: input.capability, operation: safeOperation('policy.revoke') }))) return false;
      const target = localFor(input.root, input.projectId); const old = readGrant(input.root, input.projectId);
      if (!old || !known.has(input.capability)) return false;
      if (!audit({ root: input.root, projectId: input.projectId, actor: humanActor, operation: 'policy.revoke', capability: input.capability, allowed: true, reason: 'granted' })) return false;
      old.overrides[input.capability] = 'deny'; persist(old, target.path);
      return true;
    }
  } as ProjectCapabilityBroker;
  const sealed = Object.freeze(broker);
  trustedBrokers.add(sealed);
  return sealed;
}

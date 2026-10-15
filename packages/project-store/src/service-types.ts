import type { Actor, AuthorizationPort, DocumentRef, Resource, TypeRegistry } from '@a3/domain';
import type { ProjectReadResult, ResourceBytes, StoreDiagnostic } from './types.js';

export interface AccessRequest {
  actor: Actor;
  root: string;
  projectId?: string;
  operation: 'open-project' | 'read-resource' | 'write';
  paths: readonly string[];
  refs: readonly DocumentRef[];
  resources: readonly Resource[];
}
/** Trusted host adapters, never read from project files or a renderer payload. */
export interface StoreHost {
  authenticatedActor: Actor;
  domain: AuthorizationPort;
  authorizeAccess(request: AccessRequest): boolean;
}
export type FaultPhase = 'after-intent' | 'after-staging' | 'before-detach' | 'after-detach' |
  'before-install' | 'after-install' | 'before-commit' | 'after-commit';
export interface ServiceOptions {
  host: StoreHost;
  registry?: TypeRegistry;
  pollMs?: number;
  debounceMs?: number;
  maxResourceBytes?: number;
  maxTransactionBytes?: number;
  /** Host-only fault injection. Never accepted from a project/plugin payload. */
  fault?: (phase: FaultPhase, event: { operationId: string; index?: number; path?: string }) => void | Promise<void>;
}
export interface WriteChange {
  path: string;
  ref?: DocumentRef;
  beforeHash: string | null;
  afterHash: string | null;
  bytes: number;
}
export interface PreparedWrite {
  status: 'prepared';
  operationId: string;
  projectId: string;
  changes: readonly WriteChange[];
  proposedBytes(path: string): Uint8Array | null;
}
export interface WriteReceipt {
  status: 'committed';
  operationId: string;
  atomic: false;
  paths: readonly string[];
  transactionPath: string | null;
}
export type StoreResult<T> = { ok: true; value: T; diagnostics: readonly StoreDiagnostic[] } |
  { ok: false; diagnostics: readonly StoreDiagnostic[]; recoveryRequired?: boolean; transactionPath?: string };
export interface ResourceWriteRequest {
  operationId: string;
  resourceId: string;
  expectedRevision: number;
  expectedHash: string;
  bytes: Uint8Array;
}
export interface OpenResource extends ResourceBytes {
  resourceId: string;
  revision: number;
  descriptorHash: string;
}
export type ServiceEvent =
  | { kind: 'external-change'; path: string; change: 'created' | 'deleted' | 'edited' | 'replaced' | 'unavailable'; beforeHash: string | null; afterHash: string | null; diagnostics: readonly StoreDiagnostic[] }
  | { kind: 'committed'; receipt: WriteReceipt }
  | { kind: 'write-failed' | 'watcher-error'; diagnostics: readonly StoreDiagnostic[] };
export interface ServiceState {
  mode: 'writer' | 'read-only';
  reason?: string;
  project: ProjectReadResult;
  externalConflict: boolean;
}
export interface IntentEntry extends WriteChange {
  backupPath: string;
  stagedPath: string;
  candidatePath: string;
  detachedPath: string;
}
export interface WriteIntent {
  schemaVersion: '1.0.0';
  protocol: 'a3.store.detached-link/1';
  operationId: string;
  projectId: string;
  requestHash: string;
  readSet: { path: string; hash: string | null; identity: string | null }[];
  entries: IntentEntry[];
  extensions: Record<string, unknown>;
}
export interface ProgressEvent {
  schemaVersion: '1.0.0';
  seq: number;
  previousHash: string;
  event: 'intent' | 'staged' | 'detach-start' | 'detached' | 'install-start' | 'installed' | 'verified' | 'committed' | 'failed' | 'restored-link';
  index?: number;
  detail?: string;
  hash: string;
}

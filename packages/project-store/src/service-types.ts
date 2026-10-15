import type { Actor, AuthorizationPort, DocumentRef, Resource, TypeRegistry } from '@a3/domain';
import type { ProjectReadResult, ResourceBytes, StoreDiagnostic } from './types.js';
import type { MigrationStep } from './migrations.js';
import type { SnapshotSummary } from './snapshots.js';

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
  'before-install' | 'after-install' | 'before-commit' | 'after-commit' |
  'migration-after-stage' | 'migration-before-apply' | 'migration-after-apply' |
  'recovery-after-decision' | 'recovery-after-backup-check' | 'recovery-after-entry' |
  'recovery-before-finalize' | 'recovery-after-finalize' | 'recovery-before-conflict' |
  'recovery-after-conflict' | 'recovery-before-quarantine' | 'recovery-after-quarantine';
export interface ServiceOptions {
  host: StoreHost;
  registry?: TypeRegistry;
  pollMs?: number;
  debounceMs?: number;
  maxResourceBytes?: number;
  maxTransactionBytes?: number;
  snapshotRetentionDays?: number;
  snapshotMaxBytes?: number;
  /** Trusted application migrations only; never loaded from project/package data. */
  migrationSteps?: readonly MigrationStep[];
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
  snapshotId?: string;
}
export interface MigrationReceipt {
  status: 'migrated';
  operationId: string;
  projectId: string;
  sourceVersions: readonly string[];
  targetVersion: string;
  paths: readonly string[];
  snapshotId: string;
  transactionOperationId: string | null;
  resumed: boolean;
}
export interface SnapshotReceipt extends SnapshotSummary { status: 'created' | 'reused'; }
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
  recoveryDiagnostics: readonly StoreDiagnostic[];
}
export interface IntentEntry extends WriteChange {
  backupPath: string;
  stagedPath: string;
  candidatePath: string;
  detachedPath: string;
  /** Absent in C2 journals created before E1-D1; revisions are captured in new intents. */
  revisionBefore?: number | null;
  revisionAfter?: number | null;
}
export interface WriteIntent {
  schemaVersion: '1.0.0';
  protocol: 'a3.store.detached-link/1';
  operationId: string;
  projectId: string;
  /** Stable non-secret principal identity; absent only in legacy E1-C2 journals. */
  actor?: Pick<Actor, 'kind' | 'id'>;
  requestHash: string;
  readSet: { path: string; hash: string | null; identity: string | null }[];
  entries: IntentEntry[];
  extensions: Record<string, unknown>;
}
export interface ProgressEvent {
  schemaVersion: '1.0.0';
  seq: number;
  previousHash: string;
  event: 'intent' | 'staged' | 'detach-start' | 'detached' | 'install-start' | 'installed' | 'verified' | 'committed' | 'failed' | 'restored-link' |
    'recovery-start' | 'recovery-progress' | 'recovery-committed' | 'recovery-rolled-back' | 'recovery-conflict';
  index?: number;
  detail?: string;
  hash: string;
}

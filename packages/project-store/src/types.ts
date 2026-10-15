import type { Diagnostic, DomainRecord, DomainSnapshot, JsonValue, RecordKind, TypeRegistry } from '@a3/domain';

export interface DocumentLocation {
  kind: RecordKind;
  path: string;
  workspaceId?: string;
  expectedId?: string;
  variableScope?: 'project' | 'workspace' | 'entity';
}
export interface StoreDiagnostic extends Omit<Diagnostic, 'instancePath'> {
  stage: 'syntax' | 'schema' | 'references' | 'compatibility' | 'io';
  path: string;
  pointer?: string;
  byteOffset?: number;
  line?: number;
  column?: number;
}
export interface DecodedDocument {
  readonly location: Readonly<DocumentLocation>;
  readonly status: 'valid' | 'invalid' | 'read-only';
  /** Codec eligibility only; it never grants host/filesystem permission. */
  readonly writable: boolean;
  readonly value?: JsonValue;
  readonly record?: DomainRecord;
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly sha256: string;
  /** Always returns a defensive copy, including for corrupt/unsupported files. */
  originalBytes(): Uint8Array;
}
/** An explicit edit to one JSON Pointer; omitted fields remain untouched. */
export type JsonEdit = { pointer: string; op: 'set'; value: JsonValue } | { pointer: string; op: 'remove' };
export type SerializationResult =
  | { ok: true; bytes: Uint8Array; changed: boolean; record: DomainRecord; diagnostics: StoreDiagnostic[] }
  | { ok: false; diagnostics: StoreDiagnostic[] };
export interface ReadLimits {
  maxDocumentBytes?: number;
  maxTotalBytes?: number;
  maxDocuments?: number;
}
export interface ReadProjectOptions extends ReadLimits {
  registry?: TypeRegistry;
  /** Host-only exact sources for which a registered migration authorizes reading this known layout. */
  knownReadOnlyManifestSources?: readonly string[];
}
export interface ProjectReadResult {
  root: string;
  mode: 'ready' | 'degraded' | 'read-only' | 'unavailable';
  /** C1 never grants permission to write, even when validation succeeds. */
  writable: false;
  catalogComplete: boolean;
  documents: readonly DecodedDocument[];
  snapshot: DomainSnapshot;
  diagnostics: readonly StoreDiagnostic[];
}
export interface ResourceBytes {
  bytes: Uint8Array;
  sha256: string;
  path: string;
}
export type ResourceReadResult = { ok: true; value: ResourceBytes } | { ok: false; diagnostics: StoreDiagnostic[] };

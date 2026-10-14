import { createHash } from 'node:crypto';
import { refKey, refOf, validateRecord, type DomainRecord, type JsonValue } from '@a3/domain';
import { canonicalJson, exceedsDepth, freeze, hasNegativeZero, invalidUtf8, JsonSyntaxError, object, parseJson, sourcePosition } from './json.js';
import type { DecodedDocument, DocumentLocation, JsonEdit, SerializationResult, StoreDiagnostic } from './types.js';

export const supportedVersion = '1.0.0';
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const originals = new WeakMap<DecodedDocument, { bytes: Uint8Array; fingerprint?: string }>();
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function issue(path: string, stage: StoreDiagnostic['stage'], detail: string, message: string,
  extra: Partial<StoreDiagnostic> = {}): StoreDiagnostic {
  return { code: 'VALIDATION_FAILED', severity: 'error', recovery: 'Conserva el archivo original y revisa el diagnóstico antes de proponer cambios.', path, stage, detail, message, ...extra };
}
function recordFor(location: DocumentLocation, value: unknown): DomainRecord {
  return { kind: location.kind, value, ...(location.workspaceId !== undefined ? { workspaceId: location.workspaceId } : {}) } as DomainRecord;
}
function versionIssue(location: DocumentLocation, value: unknown): StoreDiagnostic | undefined {
  const field = location.kind === 'project' ? 'formatVersion' : 'schemaVersion';
  const version = object(value) ? value[field] : undefined;
  if (typeof version !== 'string' || !versionPattern.test(version) || version === supportedVersion) return undefined;
  const major = version.split('.')[0]!;
  return issue(location.path, 'compatibility', major.length > 1 || major > '1' ? 'unsupported-major' : 'unsupported-version',
    `Versión ${version} no soportada; inspección en solo lectura, sin downgrade.`, { pointer: '/' + field, severity: 'warning' });
}
function schemaIssues(location: DocumentLocation, record: DomainRecord): StoreDiagnostic[] {
  const diagnostics: StoreDiagnostic[] = validateRecord(record).map(({ instancePath, ...d }) => ({ ...d, stage: 'schema', path: location.path,
    ...(instancePath !== undefined ? { pointer: instancePath } : {}) }));
  if (!diagnostics.length) {
    const ref = refOf(record);
    if (location.expectedId && ref.id.toLowerCase() !== location.expectedId.toLowerCase() || location.variableScope && ref.variableScope !== location.variableScope) {
      diagnostics.push(issue(location.path, 'schema', 'file-identity-mismatch', 'La identidad/alcance del documento no coincide con su archivo.', { ref }));
    }
  }
  return diagnostics;
}

export function decodeDocument(location: DocumentLocation, input: Uint8Array): DecodedDocument {
  const bytes = Uint8Array.from(input);
  const diagnostics: StoreDiagnostic[] = [];
  let status: DecodedDocument['status'] = 'invalid';
  let value: JsonValue | undefined;
  let record: DomainRecord | undefined;
  const badByte = invalidUtf8(bytes);
  if (badByte !== undefined) {
    diagnostics.push(issue(location.path, 'syntax', 'invalid-utf8', 'El JSON no contiene UTF-8 válido.', { byteOffset: badByte }));
  } else {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    try {
      const parsed = parseJson(text);
      if (parsed.concerns.length) {
        status = 'read-only';
        for (const concern of parsed.concerns) diagnostics.push(issue(location.path, 'compatibility', concern.detail, concern.message,
          { pointer: concern.pointer, ...sourcePosition(text, concern.offset), severity: 'warning' }));
        // No approximate Number values or arbitrarily chosen duplicate-key values enter the domain.
      } else {
        value = freeze(parsed.value);
        const unsupported = versionIssue(location, value);
        if (unsupported) { status = 'read-only'; diagnostics.push(unsupported); }
        else {
          const candidate = recordFor(location, value);
          const errors = schemaIssues(location, candidate);
          diagnostics.push(...errors);
          if (!errors.length) {
            record = freeze(candidate);
            status = location.kind === 'drawing' ? 'read-only' : 'valid';
            if (status === 'read-only') diagnostics.push(issue(location.path, 'compatibility', 'opaque-drawing',
              'Solo se conoce el encabezado del dibujo; su geometría no se reescribe.', { severity: 'warning' }));
          }
        }
      }
      for (const diagnostic of diagnostics) {
        const offset = parsed.positions.get(diagnostic.pointer ?? '');
        if (offset !== undefined && diagnostic.byteOffset === undefined) Object.assign(diagnostic, sourcePosition(text, offset));
      }
    } catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      if (error.detail === 'json-depth-limit') status = 'read-only';
      diagnostics.push(issue(location.path, error.detail === 'json-depth-limit' ? 'compatibility' : 'syntax', error.detail, error.message,
        { ...sourcePosition(text, error.offset), ...(status === 'read-only' ? { severity: 'warning' as const } : {}) }));
    }
  }
  const document: DecodedDocument = Object.freeze({ location: freeze({ ...location }), status, writable: status === 'valid',
    ...(value !== undefined ? { value } : {}), ...(record ? { record } : {}), diagnostics: freeze(diagnostics), sha256: sha256(bytes),
    originalBytes: () => Uint8Array.from(bytes) });
  originals.set(document, { bytes, ...(status === 'valid' && value !== undefined ? { fingerprint: canonicalJson(value) } : {}) });
  return document;
}

/** Canonical UTF-8 for a NEW complete record. Existing files use encodeDocument. */
export function serializeRecord(location: DocumentLocation, record: DomainRecord): SerializationResult {
  // DomainRecord adds one wrapper level; the serialized value is limited to 128.
  if (exceedsDepth(record, 129)) return { ok: false, diagnostics: [issue(location.path, 'compatibility', 'json-depth-limit', 'La propuesta excede la profundidad que admite el lector (128).')] };
  const diagnostics = schemaIssues(location, record);
  if (diagnostics.some((d) => d.detail === 'non-json-data' || d.detail === 'invalid-record')) return { ok: false, diagnostics };
  if (record.kind !== location.kind || ('workspaceId' in record ? record.workspaceId : undefined) !== location.workspaceId) {
    return { ok: false, diagnostics: [issue(location.path, 'schema', 'record-location-mismatch', 'El registro no coincide con su ubicación.')] };
  }
  const unsupported = versionIssue(location, record.value);
  if (unsupported) return { ok: false, diagnostics: [unsupported] };
  if (diagnostics.length) return { ok: false, diagnostics };
  if (hasNegativeZero(record.value)) return { ok: false, diagnostics: [issue(location.path, 'compatibility', 'number-not-lossless', 'El JSON canónico no puede conservar -0; usa un valor representable explícito.')] };
  if (record.kind === 'drawing') return { ok: false, diagnostics: [issue(location.path, 'compatibility', 'opaque-drawing', 'No hay codec de geometría para dibujos.')] };
  return { ok: true, bytes: Buffer.from(canonicalJson(record.value as JsonValue) + '\n', 'utf8'), changed: true, record, diagnostics: [] };
}

function applyEdit(value: JsonValue, edit: JsonEdit): void {
  if (!edit.pointer.startsWith('/') || /~(?![01])/u.test(edit.pointer)) throw new Error('El edit requiere JSON Pointer no vacío y válido.');
  const parts = edit.pointer.slice(1).split('/').map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = value;
  for (const part of parts.slice(0, -1)) {
    if ((!object(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, part)) throw new Error('La ruta del edit no existe.');
    parent = (parent as Record<string, JsonValue>)[part]!;
  }
  const key = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= parent.length) throw new Error('Índice de array ausente; reemplaza el array explícitamente para añadir miembros.');
    if (edit.op === 'remove') parent.splice(Number(key), 1);
    else parent[Number(key)] = edit.value;
  } else if (object(parent)) {
    if (edit.op === 'remove') {
      if (!Object.hasOwn(parent, key)) throw new Error('El campo a quitar no existe.');
      delete parent[key];
    } else Object.defineProperty(parent, key, { value: edit.value, writable: true, enumerable: true, configurable: true });
  } else throw new Error('El padre del edit no es objeto ni array.');
}

/** Apply only explicit edits to the full preserved tree; no edits returns original bytes exactly. */
export function encodeDocument(document: DecodedDocument, edits: readonly JsonEdit[] = []): SerializationResult {
  const original = originals.get(document);
  if (!original || !document.writable || !document.record || document.value === undefined) return { ok: false, diagnostics: [
    issue(document.location.path, 'compatibility', 'document-not-writable', 'Documento inválido, opaco o no soportado; no se puede serializar ni degradar.')
  ] };
  // JSON validates edits too: reject cycles, accessors, non-finite/undefined data before cloning.
  if (exceedsDepth(edits, 131)) return { ok: false, diagnostics: [issue(document.location.path, 'compatibility', 'json-depth-limit', 'El edit excede el presupuesto de profundidad JSON.')] };
  const probe = { ...document.record, value: { ...document.record.value, 'a3.codec.edits': edits } };
  const unsafe = validateRecord(probe);
  if (unsafe.length) return { ok: false, diagnostics: [issue(document.location.path, 'schema', 'non-json-edit', 'El edit debe contener solo datos JSON finitos.')] };
  if (hasNegativeZero(edits)) return { ok: false, diagnostics: [issue(document.location.path, 'compatibility', 'number-not-lossless', 'Un edit con -0 perdería su signo al serializar.')] };
  const value = JSON.parse(JSON.stringify(document.value)) as JsonValue;
  try { for (const edit of JSON.parse(JSON.stringify(edits)) as JsonEdit[]) {
    if (edit.op !== 'set' && edit.op !== 'remove' || typeof edit.pointer !== 'string' || edit.op === 'set' && !Object.hasOwn(edit, 'value')) throw new Error('Edit inválido.');
    applyEdit(value, edit);
  } } catch (error) {
    return { ok: false, diagnostics: [issue(document.location.path, 'schema', 'invalid-edit', error instanceof Error ? error.message : 'Edit inválido.')] };
  }
  const record = recordFor(document.location, value);
  const serialized = serializeRecord(document.location, record);
  if (!serialized.ok) return serialized;
  if (refKey(refOf(record)) !== refKey(refOf(document.record)) || JSON.stringify(refOf(record)) !== JSON.stringify(refOf(document.record)) ||
      record.value.revision < document.record.value.revision) return { ok: false, diagnostics: [
    issue(document.location.path, 'schema', 'identity-or-revision-changed', 'El codec no cambia identidad ni reduce la revisión del documento.')
  ] };
  if (canonicalJson(value) === original.fingerprint) return { ok: true, bytes: Uint8Array.from(original.bytes), changed: false, record: document.record, diagnostics: [] };
  if (record.value.revision !== document.record.value.revision + 1) return { ok: false, diagnostics: [
    issue(document.location.path, 'schema', 'revision-not-next', 'Un documento modificado requiere la siguiente revisión; el codec no la incrementa implícitamente.')
  ] };
  return { ...serialized, record: freeze(record) };
}

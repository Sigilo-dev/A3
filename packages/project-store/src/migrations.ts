import type { JsonValue, RecordKind } from '@a3/domain';
import { canonicalJson, object, parseJson } from './json.js';
import type { StoreDiagnostic } from './types.js';
import { issue } from './codec.js';

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export type MigrationScope = RecordKind | 'project' | '*';
export interface MigrationStep {
  id: string;
  scope: MigrationScope;
  fromVersion: string;
  toVersion: string;
  /** Exact JSON Pointers this trusted migration may change, excluding version/revision. */
  allowedPointers: readonly string[];
  /** Validate the exact legacy source shape before running trusted transform code. */
  validateInput(value: JsonValue, context: { path: string; scope: MigrationScope; fromVersion: string; toVersion: string }): boolean;
  /** Trusted application code; project files are data and are never evaluated. */
  transform(value: JsonValue, context: { path: string; scope: MigrationScope; fromVersion: string; toVersion: string }): JsonValue;
}
export type MigrationResult<T> = { ok: true; value: T; diagnostics: readonly StoreDiagnostic[] } |
  { ok: false; diagnostics: readonly StoreDiagnostic[] };

function versionTuple(version: string): [number, number, number] | undefined {
  const match = versionPattern.exec(version);
  if (!match) return undefined;
  const tuple = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return tuple.every(Number.isSafeInteger) ? tuple : undefined;
}
function compareVersions(left: string, right: string): number | undefined {
  const a = versionTuple(left); const b = versionTuple(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return 0;
}
function validPointer(pointer: string): boolean {
  return pointer.startsWith('/') && !/(?:~[^01])/.test(pointer);
}
function changedPointers(before: JsonValue, after: JsonValue, pointer = ''): string[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (object(before) && object(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const next = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return [next];
      return changedPointers(before[key]!, after[key]!, next);
    });
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((value, index) => changedPointers(value, after[index]!, `${pointer}/${index}`));
  }
  return [pointer || ''];
}
function migrationIssue(path: string, detail: string, message: string): StoreDiagnostic {
  return issue(path, 'compatibility', detail, message, { code: 'VALIDATION_FAILED' });
}

/** Resolve an exact, acyclic, strictly increasing chain to the requested version. */
export function migrationChain(scope: MigrationScope, fromVersion: string, toVersion: string, registry: readonly MigrationStep[], path = 'a3.project.json'): MigrationResult<readonly MigrationStep[]> {
  const direction = compareVersions(fromVersion, toVersion);
  if (direction === undefined || direction >= 0) return { ok: false, diagnostics: [migrationIssue(path, 'migration-direction-invalid', 'Solo se migra desde versiones exactas anteriores; no se degrada ni se compara una versión ambigua.')] };
  const eligible = registry.filter((step) => step.scope === scope || step.scope === '*');
  const ids = new Set<string>();
  const outgoing = new Map<string, MigrationStep>();
  for (const step of eligible) {
    const order = compareVersions(step.fromVersion, step.toVersion);
    if (!step.id || ids.has(step.id) || order !== -1 || typeof step.validateInput !== 'function' || typeof step.transform !== 'function' ||
        !Array.isArray(step.allowedPointers) || !step.allowedPointers.every(validPointer) || outgoing.has(step.fromVersion)) {
      return { ok: false, diagnostics: [migrationIssue(path, 'migration-registry-invalid', 'El registro contiene IDs repetidos, saltos no secuenciales o versiones ambiguas.')] };
    }
    ids.add(step.id); outgoing.set(step.fromVersion, step);
  }
  const chain: MigrationStep[] = [];
  let current = fromVersion;
  const seen = new Set<string>();
  while (current !== toVersion) {
    if (seen.has(current)) return { ok: false, diagnostics: [migrationIssue(path, 'migration-cycle', 'La cadena contiene un ciclo.')] };
    seen.add(current);
    const step = outgoing.get(current);
    if (!step || compareVersions(step.toVersion, toVersion) === undefined || compareVersions(step.toVersion, toVersion)! > 0) {
      return { ok: false, diagnostics: [migrationIssue(path, 'migration-path-undefined', `No existe una cadena registrada desde ${fromVersion} hasta ${toVersion}.`)] };
    }
    chain.push(step); current = step.toVersion;
    if (chain.length > registry.length) return { ok: false, diagnostics: [migrationIssue(path, 'migration-cycle', 'La cadena excede el registro disponible.')] };
  }
  return { ok: true, value: chain, diagnostics: [] };
}

/** Apply one exact version chain while enforcing revision bumps and opaque-data preservation. */
export function applyMigrationChain(scope: MigrationScope, path: string, input: JsonValue, fromVersion: string,
  versionField: 'formatVersion' | 'schemaVersion', registry: readonly MigrationStep[], targetVersion = '1.0.0'): MigrationResult<JsonValue> {
  const chain = migrationChain(scope, fromVersion, targetVersion, registry, path);
  if (!chain.ok) return chain;
  let current = input;
  for (const step of chain.value) {
    const context = { path, scope, fromVersion: step.fromVersion, toVersion: step.toVersion };
    let inputAccepted = false;
    try { inputAccepted = step.validateInput(current, context) === true; } catch { /* A failed validator rejects the source without mutation. */ }
    if (!inputAccepted || !object(current) || current[versionField] !== step.fromVersion || typeof current.revision !== 'number' || !Number.isSafeInteger(current.revision) || current.revision < 1 || current.revision >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, diagnostics: [migrationIssue(path, 'migration-input-invalid', 'El documento no cumple las precondiciones de revisión y versión de este paso.')] };
    }
    let transformed: JsonValue;
    try {
      const candidate = step.transform(current, { path, scope, fromVersion: step.fromVersion, toVersion: step.toVersion });
      const parsed = parseJson(canonicalJson(candidate));
      if (parsed.concerns.length) throw new Error('json-ambiguous');
      transformed = parsed.value;
    } catch (error) {
      return { ok: false, diagnostics: [migrationIssue(path, 'migration-transform-failed', error instanceof Error ? error.message : 'El paso falló.')] };
    }
    if (!object(transformed) || transformed[versionField] !== current[versionField] || transformed.revision !== current.revision ||
        canonicalJson(transformed.extensions ?? null) !== canonicalJson(current.extensions ?? null)) {
      return { ok: false, diagnostics: [migrationIssue(path, 'migration-opaque-data-changed', 'El paso alteró versión, revisión o extensions; esos campos los conserva el motor.')] };
    }
    const excluded = new Set([`/${versionField}`, '/revision']);
    const changed = changedPointers(current, transformed).filter((pointer) => !excluded.has(pointer));
    const declared = new Set(step.allowedPointers);
    const undeclared = changed.filter((pointer) => !declared.has(pointer));
    if (undeclared.length) return { ok: false, diagnostics: [migrationIssue(path, 'migration-undeclared-edit', `El paso cambió datos fuera de su contrato: ${undeclared.join(', ')}`)] };
    current = { ...transformed, [versionField]: step.toVersion, revision: current.revision + 1 } as JsonValue;
  }
  return { ok: true, value: current, diagnostics: [] };
}

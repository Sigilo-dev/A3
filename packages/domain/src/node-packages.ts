import type { DeclarativeNodePackage, Diagnostic, NodePackageManifest, NodeType, NodeTypeCollection, TypeRegistry } from './models.js';
import { diagnostic, isObject } from './data.js';
import { matchesTypedValue, validValueSpec } from './variables.js';
import { validateDefinition, validateNodePackageShape } from './validation.js';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const keyOf = (type: Pick<NodeType, 'name' | 'version'>): string => `${type.name}@${type.version}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const issue = (code: string, message: string): Diagnostic => diagnostic(code, message);

function executableProperty(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:entrypoints?|scripts?|script|code|sourceCode|javascript|module|worker|handler|command)$/i.test(key)) return true;
    if (executableProperty(child, seen)) return true;
  }
  seen.delete(value);
  return false;
}

export function validateDeclarativeNodePackage(value: unknown): Diagnostic[] {
  const diagnostics = validateNodePackageShape(value);
  if (diagnostics.length || !isObject(value)) return diagnostics;
  const candidate = value as unknown as DeclarativeNodePackage;
  const { manifest, nodeTypes, collections } = candidate;
  if (manifest.permissions.length !== 0 || Object.hasOwn(manifest, 'entrypoints') || executableProperty(value)) {
    diagnostics.push(issue('declarative-package-executable-content', 'Un paquete de nodos A3 solo admite datos declarativos; elimina scripts, entrypoints, comandos y código.'));
  }
  if (!semver.test(manifest.version) || !semver.test(manifest.a3ApiVersion)) diagnostics.push(issue('package-version-invalid', 'La versión del paquete y de API debe ser SemVer exacto.'));
  if (manifest.a3ApiVersion !== '1.0.0') diagnostics.push(issue('package-api-version-unsupported', `A3 solo admite paquetes declarativos con a3ApiVersion 1.0.0; se recibió ${manifest.a3ApiVersion}.`));
  const license = manifest.license.trim();
  const licenseIdentifier = /^[A-Za-z0-9][A-Za-z0-9.+() _-]{0,254}$/.test(license);
  const licenseReference = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(license);
  if (!license || license !== manifest.license || (!licenseIdentifier && !licenseReference)) {
    diagnostics.push(issue('package-license-invalid', 'La licencia debe ser un identificador/expresión declarada o una referencia HTTPS breve; A3 no verifica derechos de distribución.'));
  }
  if (!nodeTypes.length) diagnostics.push(issue('node-package-empty', 'El paquete debe definir al menos un tipo de nodo.'));
  const typeKeys = new Set<string>();
  for (const type of nodeTypes) {
    diagnostics.push(...validateDefinition('node-type', type));
    if (type.packageId !== manifest.id) diagnostics.push(issue('node-package-owner-mismatch', `El tipo ${type.name} no pertenece al paquete ${manifest.id}.`));
    const key = keyOf(type);
    if (typeKeys.has(key)) diagnostics.push(issue('node-package-duplicate-type', `El tipo ${key} aparece más de una vez.`));
    typeKeys.add(key);
    for (const field of type.fields) {
      if (field.defaultValue !== undefined && (!validValueSpec(field) || !matchesTypedValue(field.defaultValue, field))) {
        diagnostics.push(issue('node-default-value-invalid', `El valor predeterminado de ${field.name} no coincide con su tipo.`));
      }
    }
    for (const port of type.ports) {
      const cardinality = port.multiplicity;
      if (cardinality && cardinality.max !== null && cardinality.min > cardinality.max) diagnostics.push(issue('node-port-multiplicity-invalid', `La multiplicidad del puerto ${port.id} es imposible.`));
    }
    for (const mapping of [...(type.importMappings ?? []), ...(type.exportMappings ?? [])]) {
      for (const [source, target] of [...Object.entries(mapping.fields ?? {}), ...Object.entries(mapping.ports ?? {})]) {
        if (!source.trim() || !target.trim() || source.length > 256 || target.length > 256) diagnostics.push(issue('node-mapping-invalid', `El mapping ${mapping.format} contiene una ruta vacía o demasiado larga.`));
      }
    }
  }
  const collectionIds = new Set<string>();
  const covered = new Set<string>();
  for (const collection of collections) {
    if (collectionIds.has(collection.id)) diagnostics.push(issue('node-package-duplicate-collection', `La colección ${collection.id} está repetida.`));
    collectionIds.add(collection.id);
    for (const reference of collection.typeRefs) {
      const key = keyOf(reference);
      if (!typeKeys.has(key)) diagnostics.push(issue('node-collection-type-missing', `La colección ${collection.id} refiere un tipo ausente: ${key}.`));
      covered.add(key);
    }
  }
  for (const key of typeKeys) if (!covered.has(key)) diagnostics.push(issue('node-type-without-collection', `El tipo ${key} debe pertenecer a una colección del paquete.`));
  const contributes = manifest.contributes['a3.node-types'];
  const declared = { types: [...typeKeys].sort(), collections: [...collectionIds].sort() };
  const actual = { types: nodeTypes.map(keyOf).sort(), collections: collections.map((item) => item.id).sort() };
  if (!jsonEqual(contributes, declared) || !jsonEqual(declared, actual)) {
    diagnostics.push(issue('node-package-contributions-mismatch', 'manifest.contributes.a3.node-types debe enumerar exactamente los tipos y colecciones incluidos.'));
  }
  return diagnostics;
}

export function createDeclarativeNodePackage(input: {
  id: string; name: string; version: string; license: string; a3ApiVersion: string;
  nodeTypes: NodeType[]; collections: NodeTypeCollection[]; extensions?: Record<string, unknown>;
}): DeclarativeNodePackage {
  const types = input.nodeTypes.map((type) => ({ ...copy(type), packageId: input.id }));
  const collections = copy(input.collections);
  const manifest: NodePackageManifest = {
    schemaVersion: '1.0.0', id: input.id, name: input.name, version: input.version, license: input.license, a3ApiVersion: input.a3ApiVersion,
    contributes: { 'a3.node-types': { types: types.map(keyOf).sort(), collections: collections.map((item) => item.id).sort() } },
    permissions: [], extensions: {}
  };
  const value: DeclarativeNodePackage = { schemaVersion: '1.0.0', manifest, nodeTypes: types, collections, extensions: copy((input.extensions ?? {}) as DeclarativeNodePackage['extensions']) };
  const diagnostics = validateDeclarativeNodePackage(value);
  if (diagnostics.length) throw new TypeError(diagnostics.map((item) => item.message).join(' '));
  return value;
}

export function addDeclarativeNodePackage(registry: TypeRegistry, value: unknown): { registry: TypeRegistry; diagnostics: Diagnostic[] } {
  const diagnostics = validateDeclarativeNodePackage(value);
  if (diagnostics.length) return { registry: copy(registry), diagnostics };
  const candidate = copy(value as DeclarativeNodePackage);
  const next = copy(registry);
  const existing = new Set(next.nodeTypes.map(keyOf));
  const collisions = candidate.nodeTypes.filter((type) => existing.has(keyOf(type)));
  if (collisions.length) return { registry: next, diagnostics: collisions.map((type) => issue('node-type-version-exists', `El tipo ${keyOf(type)} ya está registrado; publica otra versión inmutable.`)) };
  next.nodeTypes.push(...candidate.nodeTypes);
  return { registry: next, diagnostics: [] };
}

export function declarativeNodePackageFileName(value: Pick<DeclarativeNodePackage, 'manifest'>): string {
  const { id, version } = value.manifest;
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id) || !semver.test(version)) throw new TypeError('ID o versión no válidos para el paquete.');
  return `${id}--${version}.json`;
}

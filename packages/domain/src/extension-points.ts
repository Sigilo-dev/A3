import type { Diagnostic, JsonValue } from './models.js';
import { canonical, copy, isJson, isObject, NAMESPACE_PATTERN, VERSION_PATTERN } from './data.js';

export type ExtensionPointId = 'a3.theme' | 'a3.markdown' | 'a3.language' | 'a3.provider' | 'a3.automation';
export type ExtensionPointMode = 'declarative' | 'isolated-manual-web' | 'programmed-disabled';
export type ExtensionFallback = 'default-theme' | 'source-only' | 'plain-text' | 'manual-prompt' | 'no-automation' | 'generic-data';

export interface ExtensionPointDefinition {
  id: ExtensionPointId;
  apiVersion: string;
  mode: ExtensionPointMode;
  fallback: ExtensionFallback;
  description: string;
}

/** Exact versions are intentional: no extension code or renderer migration is implied by a SemVer range. */
export const A3_EXTENSION_POINTS: Readonly<Record<ExtensionPointId, ExtensionPointDefinition>> = {
  'a3.theme': { id: 'a3.theme', apiVersion: '1.0.0', mode: 'declarative', fallback: 'default-theme', description: 'Design tokens declarativos; CSS y código no están permitidos.' },
  'a3.markdown': { id: 'a3.markdown', apiVersion: '1.0.0', mode: 'declarative', fallback: 'source-only', description: 'Reconocimiento declarativo; la fuente desconocida se preserva literalmente.' },
  'a3.language': { id: 'a3.language', apiVersion: '1.0.0', mode: 'declarative', fallback: 'plain-text', description: 'Pistas léxicas de literales; no gramáticas ejecutables ni expresiones regulares.' },
  'a3.provider': { id: 'a3.provider', apiVersion: '1.0.0', mode: 'isolated-manual-web', fallback: 'manual-prompt', description: 'Proveedor web manual aislado o declaración de proveedor de agente; nunca concede permisos.' },
  'a3.automation': { id: 'a3.automation', apiVersion: '1.0.0', mode: 'programmed-disabled', fallback: 'no-automation', description: 'Flujo declarativo de vista previa; su ejecución permanece deshabilitada.' }
};

export type ThemeToken = 'color.background' | 'color.foreground' | 'color.accent' | 'color.muted' | 'color.border' | 'font.family' | 'font.size' | 'radius' | 'spacing';
export interface ExtensionContribution extends Record<string, unknown> {
  id: string;
  extensionPoint: string;
  apiVersion: string;
  payload: unknown;
  extensions?: Record<string, JsonValue>;
}
export interface ExtensionPackageOrigin {
  kind: 'local-file' | 'local-folder' | 'catalog';
  label: string;
  catalogUrl?: string;
}
export interface ExtensionDependency { id: string; version: string; }
export interface VersionedExtensionPackage extends Record<string, unknown> {
  schemaVersion: '1.0.0';
  manifest: {
    id: string;
    name: string;
    author: string;
    version: string;
    license: string;
    a3ApiVersion: string;
    origin: ExtensionPackageOrigin;
    dependencies: ExtensionDependency[];
    permissions: string[];
    obsidianCompatibility: 'not-asserted';
    extensions: Record<string, JsonValue>;
  };
  contributions: ExtensionContribution[];
  extensions: Record<string, JsonValue>;
}

export interface RegisteredExtensionPackage {
  bundle: VersionedExtensionPackage;
  lifecycle: 'enabled' | 'disabled' | 'retired';
}
export interface ExtensionRegistry {
  schemaVersion: '1.0.0';
  packages: RegisteredExtensionPackage[];
  extensions: Record<string, JsonValue>;
}
export type ExtensionResolutionStatus = 'active' | 'declared-only' | 'inactive' | 'retired' | 'incompatible' | 'conflict' | 'unsupported';
export interface ExtensionResolution {
  packageId: string;
  packageVersion: string;
  contributionId: string;
  extensionPoint: string;
  apiVersion: string;
  status: ExtensionResolutionStatus;
  effective: boolean;
  fallback: ExtensionFallback;
  reason: string;
}
export interface ExtensionResolutionReport { resolutions: ExtensionResolution[]; diagnostics: Diagnostic[]; }

const issue = (detail: string, message: string, recovery = 'Revisa el manifiesto y la versión de API antes de volver a registrarlo.'): Diagnostic => ({
  code: 'VALIDATION_FAILED', detail, severity: 'error', message, recovery
});
const semver = (value: unknown): value is string => typeof value === 'string' && VERSION_PATTERN.test(value);
const shortText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const sameJson = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const cloneRegistry = (registry: ExtensionRegistry): ExtensionRegistry => copy(registry);
const validHttpsOrigin = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 253 || value.includes('*')) return false;
  const match = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::([1-9]\d{0,4}))?$/.exec(value);
  if (!match) return false;
  const port = match[1] === undefined ? undefined : Number(match[1]);
  return port === undefined || (port <= 65535 && port !== 443);
};
const validLicenseDeclaration = (value: unknown): value is string => shortText(value, 256) &&
  (/^[A-Za-z0-9][A-Za-z0-9.+() _-]{0,254}$/.test(value) || /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value));

function containsExecutableKey(value: unknown, ancestors = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  const found = Object.entries(value).some(([key, child]) => /^(?:entrypoints?|scripts?|script|code|sourceCode|javascript|module|worker|handler|command|eval)$/i.test(key) || containsExecutableKey(child, ancestors));
  ancestors.delete(value);
  return found;
}

function validOrigin(value: unknown): value is ExtensionPackageOrigin {
  if (!isObject(value) || !['local-file', 'local-folder', 'catalog'].includes(String(value.kind)) || !shortText(value.label, 160) || /[\\/:]/.test(value.label)) return false;
  if (value.kind === 'catalog') {
    return exactKeys(value, ['kind', 'label', 'catalogUrl']) && validHttpsOrigin(value.catalogUrl);
  }
  return exactKeys(value, ['kind', 'label']) && value.catalogUrl === undefined;
}

function extensionDependencyKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const keys: string[] = [];
  for (const dependency of value) {
    if (!isObject(dependency) || !exactKeys(dependency, ['id', 'version']) || typeof dependency.id !== 'string' || !NAMESPACE_PATTERN.test(dependency.id) || !semver(dependency.version)) return null;
    keys.push(`${dependency.id}@${dependency.version}`);
  }
  return keys;
}

function validTheme(payload: unknown): boolean {
  if (!isObject(payload) || !exactKeys(payload, ['tokens']) || !isObject(payload.tokens)) return false;
  const tokens = payload.tokens;
  const allowed = new Set<ThemeToken>(['color.background', 'color.foreground', 'color.accent', 'color.muted', 'color.border', 'font.family', 'font.size', 'radius', 'spacing']);
  if (!Object.keys(tokens).length || Object.keys(tokens).some((key) => !allowed.has(key as ThemeToken))) return false;
  return Object.entries(tokens).every(([key, value]) => {
    if (typeof value !== 'string' || value.length > 160 || /[;{}()\\\n\r]/.test(value) || /url\s*:/i.test(value)) return false;
    if (key.startsWith('color.')) return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,24})$/.test(value);
    if (key === 'font.family') return /^[A-Za-z0-9 ,_'"-]{1,96}$/.test(value);
    return /^(?:0|(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?)(?:px|rem|em)$/.test(value);
  });
}

function validMarkdown(payload: unknown): boolean {
  if (!isObject(payload) || !exactKeys(payload, ['syntaxId', 'label', 'open', 'close', 'unknownSource'])) return false;
  return typeof payload.syntaxId === 'string' && NAMESPACE_PATTERN.test(payload.syntaxId) && shortText(payload.label, 80) &&
    shortText(payload.open, 32) && shortText(payload.close, 32) && payload.open !== payload.close && payload.unknownSource === 'preserve';
}

function validLanguage(payload: unknown): boolean {
  if (!isObject(payload) || !exactKeys(payload, ['languageId', 'aliases', 'rules']) || typeof payload.languageId !== 'string' || !NAMESPACE_PATTERN.test(payload.languageId) ||
      !Array.isArray(payload.aliases) || payload.aliases.length > 16 || !payload.aliases.every((alias) => typeof alias === 'string' && /^[a-z][a-z0-9+-]{0,31}$/.test(alias)) ||
      new Set(payload.aliases).size !== payload.aliases.length || !Array.isArray(payload.rules) || payload.rules.length < 1 || payload.rules.length > 64) return false;
  const ruleIds = new Set<string>();
  return payload.rules.every((rule) => {
    if (!isObject(rule) || !exactKeys(rule, ['id', 'kind', 'literals', 'open', 'close']) || typeof rule.id !== 'string' || !NAMESPACE_PATTERN.test(rule.id) || ruleIds.has(rule.id)) return false;
    ruleIds.add(rule.id);
    if (rule.kind === 'keyword') return Array.isArray(rule.literals) && rule.literals.length > 0 && rule.literals.length <= 256 && rule.literals.every((literal) => shortText(literal, 80)) && new Set(rule.literals).size === rule.literals.length && rule.open === undefined && rule.close === undefined;
    if (rule.kind === 'line-comment') return shortText(rule.open, 16) && rule.literals === undefined && rule.close === undefined;
    if (rule.kind === 'block-comment' || rule.kind === 'string') return shortText(rule.open, 16) && shortText(rule.close, 16) && rule.open !== rule.close && rule.literals === undefined;
    return false;
  });
}

const providerPermissions = new Set(['web.manual-navigation', 'web.open-external', 'agent.turn', 'project.read', 'document.edit', 'network.access', 'process.run']);
function validProvider(payload: unknown): boolean {
  if (!isObject(payload) || !exactKeys(payload, ['kind', 'mode', 'origin', 'authentication', 'cost', 'permissions', 'terms'])) return false;
  if (!['manual-web', 'agent'].includes(String(payload.kind)) || !['manual', 'automated'].includes(String(payload.mode)) || typeof payload.origin !== 'string' ||
      !Array.isArray(payload.permissions) || payload.permissions.length > 7 || new Set(payload.permissions).size !== payload.permissions.length ||
      !payload.permissions.every((permission) => typeof permission === 'string' && providerPermissions.has(permission)) ||
      !['user-session', 'official-oauth', 'user-configured', 'unspecified'].includes(String(payload.authentication)) ||
      !['free', 'user-plan', 'paid-api', 'unspecified'].includes(String(payload.cost)) || !shortText(payload.terms, 512)) return false;
  if (!validHttpsOrigin(payload.origin)) return false;
  if (payload.kind === 'manual-web') return payload.mode === 'manual' && payload.authentication === 'user-session' &&
    payload.permissions.every((permission) => permission === 'web.manual-navigation' || permission === 'web.open-external');
  return payload.mode === 'automated' && payload.authentication !== 'user-session';
}

const automationPermissions = new Set(['task.write', 'document.edit', 'git.commit', 'git.push', 'notification.send']);
function validAutomation(payload: unknown): boolean {
  if (!isObject(payload) || !exactKeys(payload, ['trigger', 'steps', 'permissions']) || !['manual', 'on-save', 'on-task-done'].includes(String(payload.trigger)) ||
      !Array.isArray(payload.steps) || payload.steps.length < 1 || payload.steps.length > 16 ||
      !Array.isArray(payload.permissions) || payload.permissions.length > automationPermissions.size || new Set(payload.permissions).size !== payload.permissions.length ||
      !payload.permissions.every((permission) => typeof permission === 'string' && automationPermissions.has(permission))) return false;
  return payload.steps.every((step) => ['task.propose', 'prompt.compile', 'git.commit', 'git.push', 'notify'].includes(String(step))) &&
    (!payload.steps.includes('git.push') || payload.permissions.includes('git.push')) &&
    (!payload.steps.includes('git.commit') || payload.permissions.includes('git.commit')) &&
    (!payload.steps.includes('task.propose') || payload.permissions.includes('task.write')) &&
    (!payload.steps.includes('notify') || payload.permissions.includes('notification.send'));
}

function validateContribution(value: unknown, packagePermissions: string[], index: number): Diagnostic[] {
  if (!isObject(value) || !exactKeys(value, ['id', 'extensionPoint', 'apiVersion', 'payload', 'extensions']) ||
      typeof value.id !== 'string' || !NAMESPACE_PATTERN.test(value.id) || typeof value.extensionPoint !== 'string' || !NAMESPACE_PATTERN.test(value.extensionPoint) ||
      !semver(value.apiVersion) || !isJson(value.payload) || (value.extensions !== undefined && (!isObject(value.extensions) || !isJson(value.extensions)))) {
    return [issue('extension-contribution-invalid', `La contribución ${index + 1} tiene identidad, versión o datos inválidos.`)];
  }
  if (containsExecutableKey(value)) return [issue('extension-executable-content', `La contribución ${value.id} contiene campos de código o ejecución; A3 solo admite datos en estos puntos.`)];
  if (value.extensionPoint === 'a3.theme' && !validTheme(value.payload)) return [issue('extension-theme-invalid', `El tema ${value.id} no usa únicamente tokens seguros permitidos.`)];
  if (value.extensionPoint === 'a3.markdown' && !validMarkdown(value.payload)) return [issue('extension-markdown-invalid', `La extensión Markdown ${value.id} debe reconocer delimitadores literales y preservar la fuente desconocida.`)];
  if (value.extensionPoint === 'a3.language' && !validLanguage(value.payload)) return [issue('extension-language-invalid', `La gramática ${value.id} solo admite reglas léxicas declarativas de literales.`)];
  if (value.extensionPoint === 'a3.provider' && !validProvider(value.payload)) return [issue('extension-provider-invalid', `El proveedor ${value.id} debe declarar origen HTTPS, modo, autenticación, coste, condiciones y permisos.`)];
  if (value.extensionPoint === 'a3.automation' && !validAutomation(value.payload)) return [issue('extension-automation-invalid', `La automatización ${value.id} excede el flujo declarativo permitido.`)];
  if (value.extensionPoint === 'a3.provider' && isObject(value.payload) && Array.isArray(value.payload.permissions) && !value.payload.permissions.every((permission) => packagePermissions.includes(String(permission)))) {
    return [issue('extension-permission-undeclared', `El proveedor ${value.id} solicita permisos que no aparecen en el manifiesto del paquete.`)];
  }
  if (value.extensionPoint === 'a3.automation' && isObject(value.payload) && Array.isArray(value.payload.permissions) && !value.payload.permissions.every((permission) => packagePermissions.includes(String(permission))) ) {
    return [issue('extension-permission-undeclared', `La automatización ${value.id} solicita permisos que no aparecen en el manifiesto del paquete.`)];
  }
  return [];
}

export function validateVersionedExtensionPackage(value: unknown): Diagnostic[] {
  if (!isObject(value) || !isJson(value) || !exactKeys(value, ['schemaVersion', 'manifest', 'contributions', 'extensions']) || value.schemaVersion !== '1.0.0' ||
      !isObject(value.manifest) || !exactKeys(value.manifest, ['id', 'name', 'author', 'version', 'license', 'a3ApiVersion', 'origin', 'dependencies', 'permissions', 'obsidianCompatibility', 'extensions']) ||
      !isObject(value.extensions) || !isJson(value.extensions) || !Array.isArray(value.contributions) || value.contributions.length < 1 || value.contributions.length > 256) {
    return [issue('extension-package-invalid', 'El paquete no cumple el envelope de extensiones A3 1.0.0.')];
  }
  const manifest = value.manifest;
  const dependencyKeys = extensionDependencyKeys(manifest.dependencies);
  if (typeof manifest.id !== 'string' || !NAMESPACE_PATTERN.test(manifest.id) || !shortText(manifest.name, 120) || !shortText(manifest.author, 120) ||
      !semver(manifest.version) || !semver(manifest.a3ApiVersion) || manifest.a3ApiVersion !== '1.0.0' || !validLicenseDeclaration(manifest.license) ||
      manifest.obsidianCompatibility !== 'not-asserted' || !isObject(manifest.extensions) || !isJson(manifest.extensions) || !validOrigin(manifest.origin) ||
      !Array.isArray(manifest.permissions) || manifest.permissions.length > 64 || !manifest.permissions.every((permission) => typeof permission === 'string' && NAMESPACE_PATTERN.test(permission)) ||
      new Set(manifest.permissions).size !== manifest.permissions.length || dependencyKeys === null || new Set(dependencyKeys).size !== dependencyKeys.length ||
      dependencyKeys.includes(`${manifest.id}@${manifest.version}`)) {
    return [issue('extension-manifest-invalid', 'El manifiesto debe declarar identidad, autor, versión exacta, licencia, origen, dependencias, permisos y compatibilidad A3; Obsidian queda sin afirmar.')];
  }
  const bytes = JSON.stringify(value);
  if (bytes.length > 1024 * 1024 || containsExecutableKey(value)) return [issue('extension-package-executable-or-large', 'El paquete supera 1 MiB o incluye campos de ejecución; no se registra.')];
  const ids = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  value.contributions.forEach((contribution, index) => {
    diagnostics.push(...validateContribution(contribution, manifest.permissions as string[], index));
    if (isObject(contribution) && typeof contribution.id === 'string') {
      if (ids.has(contribution.id)) diagnostics.push(issue('extension-contribution-duplicate', `La contribución ${contribution.id} está duplicada en el paquete.`));
      ids.add(contribution.id);
    }
  });
  return diagnostics;
}

export function validateExtensionRegistry(value: unknown): Diagnostic[] {
  if (!isObject(value) || !exactKeys(value, ['schemaVersion', 'packages', 'extensions']) || value.schemaVersion !== '1.0.0' ||
      !Array.isArray(value.packages) || value.packages.length > 500 || !isObject(value.extensions) || !isJson(value.extensions) || !isJson(value)) {
    return [issue('extension-registry-invalid', 'El registro local de extensiones está dañado o usa una versión no compatible; se conserva sin escribir.')];
  }
  if (JSON.stringify(value).length > 4 * 1024 * 1024) return [issue('extension-registry-too-large', 'El registro excede 4 MiB y no se procesa.')];
  const diagnostics: Diagnostic[] = [];
  const versions = new Set<string>();
  value.packages.forEach((record, index) => {
    if (!isObject(record) || !exactKeys(record, ['bundle', 'lifecycle']) || !['enabled', 'disabled', 'retired'].includes(String(record.lifecycle))) {
      diagnostics.push(issue('extension-registry-record-invalid', `La entrada local ${index + 1} no tiene un estado válido.`));
      return;
    }
    diagnostics.push(...validateVersionedExtensionPackage(record.bundle));
    if (isObject(record.bundle) && isObject(record.bundle.manifest) && typeof record.bundle.manifest.id === 'string' && typeof record.bundle.manifest.version === 'string') {
      const key = `${record.bundle.manifest.id}@${record.bundle.manifest.version}`;
      if (versions.has(key)) diagnostics.push(issue('extension-registry-duplicate-version', `${key} aparece más de una vez en el registro.`));
      versions.add(key);
    }
  });
  return diagnostics;
}

export function emptyExtensionRegistry(): ExtensionRegistry {
  return { schemaVersion: '1.0.0', packages: [], extensions: {} };
}

export function registerExtensionPackage(registry: ExtensionRegistry, value: unknown): { registry: ExtensionRegistry; diagnostics: Diagnostic[] } {
  const registryDiagnostics = validateExtensionRegistry(registry);
  if (registryDiagnostics.length) return { registry, diagnostics: registryDiagnostics };
  const diagnostics = validateVersionedExtensionPackage(value);
  if (diagnostics.length || !isObject(value)) return { registry: cloneRegistry(registry), diagnostics };
  const bundle = copy(value as unknown as VersionedExtensionPackage);
  const current = registry.packages.find(({ bundle: item }) => item.manifest.id === bundle.manifest.id && item.manifest.version === bundle.manifest.version);
  if (current) {
    if (sameJson(current.bundle, bundle)) return { registry: cloneRegistry(registry), diagnostics: [] };
    return { registry: cloneRegistry(registry), diagnostics: [issue('extension-version-immutable', `${bundle.manifest.id}@${bundle.manifest.version} ya está registrado con otros bytes; publica una versión nueva.`)] };
  }
  const next = cloneRegistry(registry);
  next.packages.push({ bundle, lifecycle: 'enabled' });
  return { registry: next, diagnostics: [] };
}

function updateLifecycle(registry: ExtensionRegistry, id: string, version: string, lifecycle: RegisteredExtensionPackage['lifecycle']): { registry: ExtensionRegistry; diagnostics: Diagnostic[] } {
  const registryDiagnostics = validateExtensionRegistry(registry);
  if (registryDiagnostics.length) return { registry, diagnostics: registryDiagnostics };
  const next = cloneRegistry(registry);
  const record = next.packages.find(({ bundle }) => bundle.manifest.id === id && bundle.manifest.version === version);
  if (!record) return { registry: cloneRegistry(registry), diagnostics: [issue('extension-package-missing', `No se encontró ${id}@${version} en el registro local.`)] };
  record.lifecycle = lifecycle;
  return { registry: next, diagnostics: [] };
}

/** Deactivation preserves the entire bundle and contribution data; every consumer must use its fallback. */
export const deactivateExtensionPackage = (registry: ExtensionRegistry, id: string, version: string) => updateLifecycle(registry, id, version, 'disabled');
/** Retirement is an uninstall marker, not a content deletion or migration. */
export const retireExtensionPackage = (registry: ExtensionRegistry, id: string, version: string) => updateLifecycle(registry, id, version, 'retired');
/** Re-enabling is explicit; it restores only compatible declarative metadata, never prior permissions or runtime. */
export const activateExtensionPackage = (registry: ExtensionRegistry, id: string, version: string) => updateLifecycle(registry, id, version, 'enabled');

export function resolveExtensionRegistry(registry: ExtensionRegistry): ExtensionResolutionReport {
  const registryDiagnostics = validateExtensionRegistry(registry);
  if (registryDiagnostics.length) return { resolutions: [], diagnostics: registryDiagnostics };
  const candidates: { package: RegisteredExtensionPackage; contribution: ExtensionContribution; definition?: ExtensionPointDefinition; initial: ExtensionResolutionStatus }[] = [];
  for (const registered of registry.packages) for (const contribution of registered.bundle.contributions) {
    const definition = A3_EXTENSION_POINTS[contribution.extensionPoint as ExtensionPointId];
    const initial = registered.lifecycle === 'retired' ? 'retired' : registered.lifecycle === 'disabled' ? 'inactive' :
      !definition ? 'unsupported' : definition.apiVersion !== contribution.apiVersion ? 'incompatible' : 'active';
    candidates.push({ package: registered, contribution, definition, initial });
  }
  const claims = new Map<string, typeof candidates>();
  for (const candidate of candidates) if (candidate.initial === 'active') {
    const key = `${candidate.contribution.extensionPoint}:${candidate.contribution.id}`;
    claims.set(key, [...(claims.get(key) ?? []), candidate]);
  }
  const resolutions = candidates.map(({ package: registered, contribution, definition, initial }) => {
    const conflict = initial === 'active' && (claims.get(`${contribution.extensionPoint}:${contribution.id}`)?.length ?? 0) > 1;
    const status: ExtensionResolutionStatus = conflict ? 'conflict' : initial === 'active' && definition?.mode !== 'declarative' ? 'declared-only' : initial;
    // "effective" means admissible as data for a declared point. It does not assert a renderer/UI integration.
    const effective = status === 'active' && definition?.mode === 'declarative';
    const fallback = definition?.fallback ?? 'generic-data';
    const reason = status === 'active' ? (effective ? 'compatible-declarative-contract' : 'compatible-but-runtime-disabled') :
      status === 'inactive' ? 'package-deactivated' : status === 'retired' ? 'package-retired' : status === 'incompatible' ? 'api-version-unsupported' :
      status === 'conflict' ? 'duplicate-contribution-id' : status === 'declared-only' ? 'compatible-but-runtime-disabled' : 'extension-point-unknown';
    return { packageId: registered.bundle.manifest.id, packageVersion: registered.bundle.manifest.version, contributionId: contribution.id,
      extensionPoint: contribution.extensionPoint, apiVersion: contribution.apiVersion, status, effective, fallback, reason };
  });
  const diagnostics: Diagnostic[] = resolutions.filter(({ status }) => status !== 'active').map((resolution) => issue(
    `extension-${resolution.status}`, `${resolution.packageId}@${resolution.packageVersion}/${resolution.contributionId} no está activo (${resolution.reason}); se usa ${resolution.fallback}.`,
    resolution.status === 'incompatible' ? 'Actualiza la extensión mediante una versión de API aceptada; A3 conserva el paquete y usa el fallback.' : 'Resuelve el conflicto o vuelve a activar una versión compatible; no se descartan los datos guardados.'
  ));
  return { resolutions, diagnostics };
}

export const EXTENSION_HOST_CHANNEL = 'a3.extensions:command';
export const EXTENSION_CAPABILITIES = ['project.read', 'document.edit', 'network.access', 'process.run'] as const;
export type ExtensionCapability = typeof EXTENSION_CAPABILITIES[number];
export type ExtensionScope = { resourceIds: string[] } | { origins: string[] } | { executableIds: string[] };
export type ExtensionScopes = Partial<Record<ExtensionCapability, ExtensionScope>>;
export interface ProgrammedExtensionManifest {
  profile: 'programmed-extension';
  schemaVersion: '1.0.0'; id: string; name: string; version: string; license: string; a3ApiVersion: '1.0.0';
  contributes: Record<string, unknown>; permissions: ExtensionCapability[]; scopes: ExtensionScopes;
  entrypoints: { main: { path: string; sha256: string } }; extensions: Record<string, unknown>;
}
export interface ExtensionView {
  manifest: ProgrammedExtensionManifest; integrity: string; disabled: boolean;
  rollbackVersion?: string;
  permissions: { capability: ExtensionCapability; requested: ExtensionScope; approved?: ExtensionScope; effective: false; reason: 'sandbox-unavailable' }[];
}
export interface ExtensionHostSnapshot {
  projectId: string; runtimeAvailable: false; runtimeCode: 'EXTENSION_SANDBOX_UNAVAILABLE';
  capabilities: { capability: ExtensionCapability; available: false }[]; extensions: ExtensionView[];
}
export interface ExtensionReview {
  token: string; manifest: ProgrammedExtensionManifest; integrity: string; sourceIntegrity: string;
  previousVersion?: string; changes: { capability: ExtensionCapability; before?: ExtensionScope; after?: ExtensionScope }[];
  license: string; licenseAcknowledgementRequired: true; compatible: true; clearsApprovals: boolean; runtimeAvailable: false;
}
export type ExtensionsRequest = { action: 'status'; sessionId: string }
  | { action: 'review'; sessionId: string; bytes: Uint8Array }
  | { action: 'apply'; sessionId: string; token: string; licenseAcknowledged: boolean }
  | { action: 'grant'; sessionId: string; id: string; integrity: string; capability: ExtensionCapability; scope: ExtensionScope }
  | { action: 'revoke'; sessionId: string; id: string; integrity: string; capability: ExtensionCapability }
  | { action: 'rollback'; sessionId: string; id: string; integrity: string }
  | { action: 'disable' | 'remove' | 'start'; sessionId: string; id: string; integrity: string };
export type ExtensionsResult = { ok: true; value: ExtensionHostSnapshot | ExtensionReview } |
  { ok: false; error: { code: string; message: string; recovery: string } };

const namespace = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const extensionUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const extensionDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const extensionObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validExtensionPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.length > 0 && !/[\\:\x00-\x1f<>"|?*]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
      !/^(?:\.git|\.a3|node_modules)$/i.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function scopeValues(capability: ExtensionCapability, scope: unknown): string[] | undefined {
  if (!extensionObject(scope)) return undefined;
  const key = capability === 'network.access' ? 'origins' : capability === 'process.run' ? 'executableIds' : 'resourceIds';
  const values = scope[key];
  if (Object.keys(scope).length !== 1 || !Array.isArray(values) || values.length < 1 || values.length > 256 || new Set(values).size !== values.length) return undefined;
  if (!values.every((value) => {
    if (capability === 'network.access') {
      try { const url = new URL(value); return typeof value === 'string' && value.length <= 512 && url.protocol === 'https:' && !url.hostname.includes('*') && url.origin === value; } catch { return false; }
    }
    return capability === 'process.run' ? typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value) : extensionUuid(value);
  })) return undefined;
  return values as string[];
}
export function validProgrammedExtension(value: unknown): value is ProgrammedExtensionManifest {
  if (!extensionObject(value) || Object.keys(value).length !== 12 ||
      !Object.keys(value).every((key) => ['schemaVersion', 'id', 'name', 'version', 'license', 'a3ApiVersion', 'contributes', 'permissions', 'scopes', 'entrypoints', 'extensions', 'profile'].includes(key))) return false;
  if (value.profile !== 'programmed-extension' || value.schemaVersion !== '1.0.0' || value.a3ApiVersion !== '1.0.0' ||
      typeof value.id !== 'string' || !namespace.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 ||
      typeof value.version !== 'string' || !version.test(value.version) || typeof value.license !== 'string' || !value.license.trim() || value.license.length > 256 || /[\r\n\x00]/.test(value.license) ||
      !extensionObject(value.extensions) || !Object.keys(value.extensions).every((key) => namespace.test(key)) ||
      !extensionObject(value.contributes) || !Object.keys(value.contributes).every((key) => namespace.test(key)) ||
      !Array.isArray(value.permissions) || value.permissions.length > 4 || new Set(value.permissions).size !== value.permissions.length ||
      !value.permissions.every((cap) => EXTENSION_CAPABILITIES.includes(cap)) || !extensionObject(value.scopes) ||
      Object.keys(value.scopes).length !== value.permissions.length) return false;
  const scopes = value.scopes, permissions = value.permissions as ExtensionCapability[];
  if (!Object.keys(scopes).every((cap) => permissions.includes(cap as ExtensionCapability)) ||
      !permissions.every((cap) => !!scopeValues(cap, scopes[cap]))) return false;
  return extensionObject(value.entrypoints) && Object.keys(value.entrypoints).length === 1 && extensionObject(value.entrypoints.main) &&
    Object.keys(value.entrypoints.main).length === 2 && validExtensionPath(value.entrypoints.main.path) && extensionDigest(value.entrypoints.main.sha256);
}
export function validExtensionsRequest(value: unknown): value is ExtensionsRequest {
  if (!extensionObject(value) || !extensionUuid(value.sessionId)) return false;
  const keys = (allowed: string[]): boolean => Object.keys(value).length === allowed.length + 2 && Object.keys(value).every((key) => ['action', 'sessionId', ...allowed].includes(key));
  if (value.action === 'status') return keys([]);
  if (value.action === 'review') return keys(['bytes']) && value.bytes instanceof Uint8Array && value.bytes.byteLength <= 256 * 1024;
  if (value.action === 'apply') return keys(['token', 'licenseAcknowledged']) && extensionUuid(value.token) && typeof value.licenseAcknowledged === 'boolean';
  if (typeof value.id !== 'string' || !namespace.test(value.id) || !extensionDigest(value.integrity)) return false;
  if (['disable', 'remove', 'start', 'rollback'].includes(String(value.action))) return keys(['id', 'integrity']);
  if (!EXTENSION_CAPABILITIES.includes(value.capability as ExtensionCapability)) return false;
  if (value.action === 'revoke') return keys(['id', 'integrity', 'capability']);
  return value.action === 'grant' && keys(['id', 'integrity', 'capability', 'scope']) && !!scopeValues(value.capability as ExtensionCapability, value.scope);
}

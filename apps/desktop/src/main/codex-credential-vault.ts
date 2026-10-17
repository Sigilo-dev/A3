import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderCondition } from '../shared/codex-provider-status';

export interface TokenSet {
  accessToken: string; refreshToken?: string; idToken: string; scopes: string[]; expiresAt: number;
}
export interface Registration {
  id: string; clientId: string; subject: string; tokens?: TokenSet;
  providerCondition?: ProviderCondition; inferenceVerified?: boolean; reauthorizationRequired?: boolean;
}
export interface CredentialState {
  version: 1; hostId: string; activeId: string | null; accounts: Registration[];
}
export interface CredentialVault {
  available(): boolean;
  load(): Promise<CredentialState>;
  save(state: CredentialState): Promise<void>;
}
export interface SystemEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
}
export const emptyCredentials = (): CredentialState => ({ version: 1, hostId: 'urn:uuid:' + randomUUID(), activeId: null, accounts: [] });

export function validateCredentials(value: unknown): CredentialState {
  const state = value as CredentialState;
  const text = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 32768;
  if (!state || state.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/.test(state.hostId) || !Array.isArray(state.accounts) || state.accounts.length > 32 ||
      !(state.activeId === null || typeof state.activeId === 'string')) throw new Error('Invalid credential envelope');
  const ids = new Set<string>(), clients = new Set<string>();
  for (const item of state.accounts) {
    if (!text(item.id) || !text(item.clientId) || item.clientId === 'dynamic_agent_client' || !text(item.subject) || ids.has(item.id) || clients.has(item.clientId)) throw new Error('Invalid registration');
    if (item.providerCondition !== undefined && !['not-eligible', 'limit-exhausted', 'unavailable'].includes(item.providerCondition) ||
        item.inferenceVerified !== undefined && typeof item.inferenceVerified !== 'boolean' ||
        item.reauthorizationRequired !== undefined && typeof item.reauthorizationRequired !== 'boolean') throw new Error('Invalid authorization status');
    ids.add(item.id); clients.add(item.clientId);
    if (item.tokens) {
      const token = item.tokens;
      if (!text(token.accessToken) || !text(token.idToken) || token.refreshToken !== undefined && !text(token.refreshToken) ||
          !Number.isFinite(token.expiresAt) || !Array.isArray(token.scopes) || token.scopes.length > 64 || !token.scopes.every(text)) throw new Error('Invalid token set');
    }
  }
  if (state.activeId !== null && !ids.has(state.activeId)) throw new Error('Unknown active registration');
  return state;
}

/** Only encrypted bytes ever reach disk; no plaintext fallback or project path parameter. */
export class SystemCredentialVault implements CredentialVault {
  readonly directory: string;
  constructor(userData: string, private readonly encryption: SystemEncryption, private readonly platform = process.platform) {
    this.directory = join(userData, 'codex-authorization');
  }
  available(): boolean {
    try {
      // Windows DPAPI is the validated target. Linux must first pass its own backend evidence.
      return this.platform === 'win32' && this.encryption.isEncryptionAvailable();
    } catch { return false; }
  }
  async load(): Promise<CredentialState> {
    if (!this.available()) throw new Error('Protected storage unavailable');
    try {
      const bytes = await readFile(join(this.directory, 'credentials.bin'));
      if (bytes.length > 1048576) throw new Error('Credential envelope too large');
      return validateCredentials(JSON.parse(this.encryption.decryptString(bytes)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCredentials();
      // Do not replace an unreadable or corrupt credential file with an empty account.
      throw new Error('Protected credentials unreadable');
    }
  }
  async save(state: CredentialState): Promise<void> {
    if (!this.available()) throw new Error('Protected storage unavailable');
    const bytes = this.encryption.encryptString(JSON.stringify(validateCredentials(state)));
    if (bytes.length > 1048576) throw new Error('Credential envelope too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, 'credentials.bin'));
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}

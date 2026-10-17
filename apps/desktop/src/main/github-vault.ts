import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SystemEncryption } from './codex-credential-vault.ts';
import { githubNeed, GithubError } from './github-api.ts';
export interface GithubVault { available(): boolean; read(): Promise<string | null>; save(token: string): Promise<void>; clear(): Promise<void>; }
export function validGithubToken(token: string): boolean { return /^(?:github_pat_[A-Za-z0-9_]{20,240}|gh[pousr]_[A-Za-z0-9]{20,240})$/.test(token); }
/** Separate from ChatGPT credentials; Windows DPAPI, host userData only, no plaintext fallback. */
export class ProtectedGithubVault implements GithubVault {
  private readonly path: string;
  constructor(private readonly userData: string, private readonly encryption: SystemEncryption, private readonly platform = process.platform) { this.path = join(userData, 'github-authorization', 'credentials.bin'); }
  available(): boolean { try { return this.platform === 'win32' && this.encryption.isEncryptionAvailable(); } catch { return false; } }
  async read(): Promise<string | null> {
    githubNeed(this.available(), 'protected-storage-unavailable');
    try { const bytes = await readFile(this.path); githubNeed(bytes.length <= 32768, 'protected-storage-unreadable'); const token = this.encryption.decryptString(bytes); githubNeed(validGithubToken(token), 'protected-storage-unreadable'); return token; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new GithubError('protected-storage-unreadable'); }
  }
  async save(token: string): Promise<void> {
    githubNeed(this.available() && validGithubToken(token), 'protected-storage-unavailable');
    const directory = join(this.userData, 'github-authorization'); await mkdir(directory, { recursive: true, mode: 0o700 }); const temp = join(directory, randomUUID() + '.tmp');
    try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(this.encryption.encryptString(token)); await file.sync(); } finally { await file.close(); } await rename(temp, this.path); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  async clear(): Promise<void> { try { await unlink(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GithubError('protected-storage-unreadable'); } }
}

import { randomUUID, createHash } from 'node:crypto';
import type { GithubReview, GithubValue } from '../shared/github-publishing.ts';
import { githubDestination, githubNeed, GithubError, type GithubApi } from './github-api.ts';
import type { GithubVault } from './github-vault.ts';
import { validGitBranch } from './git-process.ts';
export interface PublishingSource {
  snapshot(): Promise<{ head: string; branch: string; files: { path: string; bytes: number }[]; bytes: number; objects: number }>;
  pack(head: string): Promise<Buffer>;
}
export interface PublishingHost {
  context(sessionId: string): Promise<{ root: string; projectId: string }>;
  authorize(sessionId: string, stage: 'prepare' | 'apply'): Promise<boolean>;
  source(sessionId: string): Promise<PublishingSource>;
  confirm(review: GithubReview): Promise<boolean>;
  push(input: { pack: Buffer; url: string; branch: string; head: string; token: string }, signal: AbortSignal): Promise<void>;
}
interface Pending { view: GithubReview; sessionId: string; projectId: string; credentialHash: string; sourceBranch: string; expires: number; abort: AbortController; used: boolean; }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** No project files, credentials or remote side effects are changed by reviewing. */
export class GithubPublishing {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly api: GithubApi, private readonly vault: GithubVault, private readonly host: PublishingHost) {}
  cancelAll(): void { for (const pending of this.pending.values()) pending.abort.abort(); this.pending.clear(); }
  cancel(sessionId: string, token: string): void { const pending = this.pending.get(token); if (pending?.sessionId === sessionId) { pending.abort.abort(); this.pending.delete(token); } }
  private async credential(): Promise<string> { const token = await this.vault.read(); githubNeed(token, 'manual-authorization-required'); return token!; }
  async status(): Promise<GithubValue> {
    if (!this.vault.available()) return { state: 'manual', protectedStorage: false };
    const token = await this.vault.read(); return token ? { state: 'connected', protectedStorage: true, account: await this.api.user(token) } : { state: 'manual', protectedStorage: true };
  }
  async review(sessionId: string, input: { kind: 'push' | 'create'; url: string; branch: string; visibility: 'private' | 'public' }): Promise<GithubReview> {
    const context = await this.host.context(sessionId); githubNeed(await this.host.authorize(sessionId, 'prepare'), 'permission-denied');
    const destination = githubDestination(input.url); githubNeed(validGitBranch(input.branch), 'invalid-branch');
    const credential = await this.credential(), account = await this.api.user(credential), source = await this.host.source(sessionId), snapshot = await source.snapshot();
    let remoteId: number | undefined;
    if (input.kind === 'create') githubNeed(destination.owner.toLowerCase() === account.login.toLowerCase(), 'create-owner-mismatch');
    else {
      const remote = await this.api.repository(credential, destination.url);
      githubNeed(remote.fullName.toLowerCase() === `${destination.owner}/${destination.name}`.toLowerCase(), 'destination-mismatch');
      githubNeed(remote.canPush, 'remote-permission-denied'); githubNeed(remote.visibility === input.visibility, 'visibility-mismatch'); remoteId = remote.id;
    }
    const view: GithubReview = { token: randomUUID(), kind: input.kind, root: context.root, account, url: destination.url, visibility: input.visibility, branch: input.branch, commit: snapshot.head,
      files: snapshot.files, historyObjects: snapshot.objects, bytes: snapshot.bytes, ...(remoteId ? { remoteId } : {}),
      exclusions: ['.a3/local', 'credenciales/claves/secretos', 'caché y dependencias', 'montajes externos no incluidos en commits', 'otras ramas y tags'] };
    for (const [id, pending] of this.pending) if (pending.expires < Date.now()) { pending.abort.abort(); this.pending.delete(id); }
    githubNeed(this.pending.size < 8, 'review-limit');
    this.pending.set(view.token, { view, sessionId, projectId: context.projectId, credentialHash: hash(credential), sourceBranch: snapshot.branch, expires: Date.now() + 300000, abort: new AbortController(), used: false }); return structuredClone(view);
  }
  async apply(sessionId: string, token: string, confirmedUrl: string): Promise<GithubValue> {
    const pending = this.pending.get(token); githubNeed(pending && pending.sessionId === sessionId && !pending.used && pending.expires >= Date.now(), 'review-expired');
    const p = pending!; githubNeed(confirmedUrl === p.view.url, 'destination-mismatch'); p.used = true;
    let remoteStarted = false;
    try {
      const verify = async (): Promise<string> => {
        githubNeed(!p.abort.signal.aborted, 'cancelled'); const current = await this.host.context(sessionId);
        githubNeed(current.root === p.view.root && current.projectId === p.projectId, 'stale-session');
        githubNeed(await this.host.authorize(sessionId, 'prepare'), 'permission-denied');
        const credential = await this.credential(); githubNeed(hash(credential) === p.credentialHash, 'authorization-changed'); return credential;
      };
      let credential = await verify();
      githubNeed(await this.host.confirm(p.view), 'cancelled'); githubNeed(await this.host.authorize(sessionId, 'apply'), 'permission-denied'); credential = await verify();
      const account = await this.api.user(credential, p.abort.signal); githubNeed(account.id === p.view.account.id && account.login === p.view.account.login, 'account-mismatch');
      const source = await this.host.source(sessionId), snapshot = await source.snapshot();
      githubNeed(snapshot.head === p.view.commit && snapshot.branch === p.sourceBranch, 'review-conflict');
      const destination = githubDestination(p.view.url);
      if (p.view.kind === 'create') {
        await verify(); remoteStarted = true;
        const created = await this.api.create(credential, destination.name, p.view.visibility, p.abort.signal);
        githubNeed(created.fullName.toLowerCase() === `${destination.owner}/${destination.name}`.toLowerCase() && created.visibility === p.view.visibility, 'remote-result-uncertain');
        return { completed: 'created', url: p.view.url }; // Creating is not consent to push.
      }
      const remote = await this.api.repository(credential, p.view.url, p.abort.signal);
      githubNeed(remote.id === p.view.remoteId && remote.fullName.toLowerCase() === `${destination.owner}/${destination.name}`.toLowerCase(), 'destination-mismatch');
      githubNeed(remote.canPush, 'remote-permission-denied'); githubNeed(remote.visibility === p.view.visibility, 'visibility-mismatch');
      const pack = await source.pack(p.view.commit); credential = await verify(); remoteStarted = true;
      await this.host.push({ pack, url: p.view.url, branch: p.view.branch, head: p.view.commit, token: credential }, p.abort.signal);
      return { completed: 'pushed', url: p.view.url, commit: p.view.commit };
    } catch (error) {
      if (remoteStarted && (!(error instanceof GithubError) || error.code === 'cancelled')) throw new GithubError('remote-result-uncertain');
      throw error;
    } finally { this.pending.delete(token); }
  }
}

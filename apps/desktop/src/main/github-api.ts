import type { GithubAccount } from '../shared/github-publishing.ts';
export const GITHUB_API_VERSION = '2026-03-10';
export class GithubError extends Error { constructor(readonly code: string) { super(code); } }
export const githubNeed = (value: unknown, code: string): void => { if (!value) throw new GithubError(code); };
export function githubDestination(value: string): { url: string; owner: string; name: string } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(value);
  githubNeed(match && !['.', '..'].includes(match[2]!), 'invalid-destination');
  return { url: `https://github.com/${match![1]}/${match![2]}.git`, owner: match![1]!, name: match![2]! };
}
export interface GithubRepository { id: number; fullName: string; visibility: 'public' | 'private'; canPush: boolean; }
export interface GithubApi {
  user(token: string, signal?: AbortSignal): Promise<GithubAccount>;
  repository(token: string, url: string, signal?: AbortSignal): Promise<GithubRepository>;
  branchHead?(token: string, url: string, branch: string, signal?: AbortSignal): Promise<string | null>;
  create(token: string, name: string, visibility: 'public' | 'private', signal?: AbortSignal): Promise<GithubRepository>;
}
function account(value: unknown): GithubAccount {
  const v = value as GithubAccount;
  githubNeed(v && Number.isSafeInteger(v.id) && v.id > 0 && /^[A-Za-z0-9-]{1,39}$/.test(v.login), 'invalid-api-response');
  return { id: v.id, login: v.login };
}
function repository(value: unknown): GithubRepository {
  const v = value as { id: number; full_name: string; private: boolean; archived: boolean; disabled: boolean; permissions?: { push?: boolean } };
  githubNeed(v && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.full_name === 'string' && typeof v.private === 'boolean', 'invalid-api-response');
  const destination = githubDestination('https://github.com/' + v.full_name);
  return { id: v.id, fullName: destination.owner + '/' + destination.name, visibility: v.private ? 'private' : 'public', canPush: v.permissions?.push === true && !v.archived && !v.disabled };
}
/** Fixed API origin, no redirect, bounded body, no raw response/error/log containing credentials. */
export class OfficialGithubApi implements GithubApi {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async call(token: string, path: string, signal?: AbortSignal, body?: object): Promise<unknown> {
    githubNeed(/^(?:\/user|\/user\/repos|\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/git\/ref\/heads\/[A-Za-z0-9_.%/-]+)?)$/.test(path), 'invalid-destination');
    try {
      const response = await this.request('https://api.github.com' + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'A3-desktop', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); throw new GithubError(response.status === 401 ? 'authorization-expired' : response.status === 403 ? 'remote-permission-denied' : response.status === 404 ? 'remote-unavailable' : response.status === 422 ? 'remote-conflict' : 'github-unavailable'); }
      const reader = response.body?.getReader(); githubNeed(reader, 'invalid-api-response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader!.read(); if (next.done) break; size += next.value.length; githubNeed(size <= 1048576, 'api-output-limit'); chunks.push(next.value); } }
      finally { await reader!.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof GithubError) throw error; throw new GithubError(signal?.aborted ? 'cancelled' : body ? 'remote-result-uncertain' : 'github-unavailable'); }
  }
  async user(token: string, signal?: AbortSignal): Promise<GithubAccount> { return account(await this.call(token, '/user', signal)); }
  async repository(token: string, url: string, signal?: AbortSignal): Promise<GithubRepository> { const d = githubDestination(url); return repository(await this.call(token, `/repos/${d.owner}/${d.name}`, signal)); }
  async branchHead(token: string, url: string, branch: string, signal?: AbortSignal): Promise<string | null> {
    const d = githubDestination(url); githubNeed(/^(?![-/])(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))[\p{L}\p{N}_./-]{1,120}$/u.test(branch) && branch.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.')), 'invalid-branch');
    try {
      const result = await this.call(token, `/repos/${d.owner}/${d.name}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, signal) as { object?: { sha?: unknown } };
      const sha = result?.object?.sha;
      githubNeed(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha), 'invalid-api-response'); return sha as string;
    } catch (error) { if (error instanceof GithubError && error.code === 'remote-unavailable') return null; throw error; }
  }
  async create(token: string, name: string, visibility: 'public' | 'private', signal?: AbortSignal): Promise<GithubRepository> {
    githubNeed(/^[A-Za-z0-9_.-]{1,100}$/.test(name), 'invalid-destination');
    return repository(await this.call(token, '/user/repos', signal, { name, private: visibility === 'private', auto_init: false }));
  }
}

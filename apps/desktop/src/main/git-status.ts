import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { GitRepositoryKind, GitRepositoryStatus, GitStatusEntry } from '../shared/git-status.ts';
import { GitStatusError, runGitStatusCommand, type GitInstallation } from './git-process.ts';
import { protectedGitPath, validGitRelativePath } from './git-status-policy.ts';

export interface HostGitRepository {
  repositoryId: string;
  projectId: string;
  kind: GitRepositoryKind;
  /** Only the host resolves a project or locally granted mount ID to this path. */
  root: string;
}
interface BoundRepository extends HostGitRepository { identity: string; }
export interface GitStatusHost {
  /** Check effective git.status plus mount.read for a referenced root, on every command. */
  authorize(repository: Readonly<HostGitRepository>, capability: 'git.status'): Promise<boolean>;
}
const id = (value: string): boolean => typeof value === 'string' && /^[\w-]{1,96}$/.test(value);
const equalPath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const decode = (bytes: Uint8Array): string => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new GitStatusError('invalid-output'); }
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
async function directoryIdentity(path: string): Promise<string> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || !equalPath(await realpath(path), resolve(path))) throw new GitStatusError('root-changed');
    return `${stat.dev}:${stat.ino}`;
  } catch (error) { if (error instanceof GitStatusError) throw error; throw new GitStatusError('root-unavailable'); }
}
async function observeRoot(root: string): Promise<string> {
  const absolute = resolve(root), base = parse(absolute).root;
  let current = base;
  for (const part of relative(base, absolute).split(sep).filter(Boolean)) { current = join(current, part); await directoryIdentity(current); }
  return directoryIdentity(absolute);
}

/** Conservative read-only v1: ordinary repositories, no external metadata/config or executable filters. */
async function inspectRepository(repository: BoundRepository, fullScan: boolean): Promise<{ gitIdentity: string; configHash: string } | null> {
  if (await observeRoot(repository.root) !== repository.identity) throw new GitStatusError('root-changed');
  const git = join(repository.root, '.git');
  try { await lstat(git); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new GitStatusError('root-unavailable');
  }
  const gitInfo = await lstat(git);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) throw new GitStatusError('unsupported-repository');
  const gitIdentity = await directoryIdentity(git), configPath = join(git, 'config');
  const configStat = await lstat(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 262144) throw new GitStatusError('unsupported-repository');
  const config = await readFile(configPath), text = decode(config);
  // Deliberately conservative, including comments/values: Git status can invoke clean filters.
  // Do this before any Git process so includes never get a chance to load outside configuration.
  if (/(?:include|filter|attributesfile|worktreeconfig|alternaterefscommand)/i.test(text) ||
      /^\s*(?:\[\s*extensions\s*\]|worktree\s*=|bare\s*=\s*(?:true|yes|on|1)\b)/im.test(text)) throw new GitStatusError('unsupported-repository');
  if (fullScan) {
    let visited = 0;
    const walk = async (directory: string, metadata: boolean): Promise<void> => {
      for (const name of await readdir(directory)) {
        if (++visited > 50_000) throw new GitStatusError('output-limit');
        const path = join(directory, name), portable = relative(repository.root, path).split(sep).join('/');
        if (!metadata && name.toLowerCase() === '.git' && !equalPath(directory, repository.root)) throw new GitStatusError('unsupported-repository');
        if (!metadata && protectedGitPath(portable)) continue;
        if (metadata && ['commondir', 'gitdir', 'worktrees', 'alternates', 'http-alternates', 'config.worktree'].includes(name.toLowerCase())) throw new GitStatusError('unsupported-repository');
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new GitStatusError('unsupported-repository');
        if (stat.isDirectory()) await walk(path, metadata);
      }
    };
    await walk(git, true);
    await walk(repository.root, false);
  }
  return { gitIdentity, configHash: hash(config) };
}

export function parseGitStatus(bytes: Uint8Array): { branch: string | null; head: string | null; unborn: boolean; entries: GitStatusEntry[] } {
  const text = decode(bytes);
  if (!text.endsWith('\0')) throw new GitStatusError('invalid-output');
  const entries: GitStatusEntry[] = [];
  let branch: string | null = null, head: string | null = null, unborn = false, sawBranch = false, sawHead = false;
  for (const record of text.slice(0, -1).split('\0')) {
    if (record.startsWith('# branch.head ')) {
      const value = record.slice(14);
      if (sawBranch || !value || /[\x00-\x20\x7f]/.test(value)) throw new GitStatusError('invalid-output');
      branch = value === '(detached)' ? null : value; sawBranch = true; continue;
    }
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice(13); if (sawHead || value !== '(initial)' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new GitStatusError('invalid-output');
      unborn = value === '(initial)'; head = unborn ? null : value; sawHead = true; continue;
    }
    if (record.startsWith('# ')) continue; // Do not expose upstream names or remote URLs.
    let entry: GitStatusEntry;
    if (record.startsWith('? ')) entry = { kind: 'untracked', path: record.slice(2), index: '?', worktree: '?' };
    else {
      const unmerged = record.startsWith('u '), fields = unmerged ? 10 : 8;
      if (!unmerged && !record.startsWith('1 ')) throw new GitStatusError('invalid-output');
      let cursor = 0;
      for (let count = 0; count < fields; count++) { cursor = record.indexOf(' ', cursor) + 1; if (!cursor) throw new GitStatusError('invalid-output'); }
      const xy = record.split(' ', 2)[1]!;
      if (!/^[.MTADRCU]{2}$/.test(xy)) throw new GitStatusError('invalid-output');
      entry = { kind: unmerged ? 'unmerged' : 'tracked', path: record.slice(cursor), index: xy[0]!, worktree: xy[1]! };
    }
    if (!validGitRelativePath(entry.path)) throw new GitStatusError('invalid-output');
    if (!protectedGitPath(entry.path)) entries.push(entry);
  }
  if (!sawBranch || !sawHead) throw new GitStatusError('invalid-output');
  return { branch, head, unborn, entries };
}

/** Host-only bindings. No arbitrary command, renderer path, remote operation, write, or process.run. */
export class LocalGitStatusAdapter {
  private readonly repositories = new Map<string, BoundRepository>();
  constructor(private readonly installation: GitInstallation, private readonly host: GitStatusHost) {}
  private async authorized(repository: HostGitRepository, bound = true): Promise<boolean> {
    const current = (): boolean => !bound || this.repositories.get(repository.repositoryId) === repository;
    try { return current() && await this.host.authorize(repository, 'git.status') && current(); } catch { return false; }
  }

  async bind(input: HostGitRepository): Promise<void> {
    if (!id(input.repositoryId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.projectId) ||
        !['a3-project', 'referenced'].includes(input.kind) || !isAbsolute(input.root) || this.repositories.has(input.repositoryId)) throw new GitStatusError('invalid-binding');
    const root = resolve(input.root), binding = Object.freeze({ ...input, root });
    if (!await this.authorized(binding, false)) throw new GitStatusError('permission-denied');
    const identity = await observeRoot(root);
    if (this.repositories.has(input.repositoryId)) throw new GitStatusError('invalid-binding');
    this.repositories.set(input.repositoryId, Object.freeze({ ...binding, identity }));
  }
  unbind(repositoryId: string): void { this.repositories.delete(repositoryId); }

  async status(repositoryId: string, signal?: AbortSignal): Promise<GitRepositoryStatus> {
    const repository = this.repositories.get(repositoryId);
    if (!repository) throw new GitStatusError('repository-not-bound');
    const base = { repositoryId, kind: repository.kind, entries: [], excludedTrackedCount: 0, diagnostics: [] };
    try {
      if (!await this.authorized(repository)) throw new GitStatusError('permission-denied');
      if (signal?.aborted) throw new GitStatusError('cancelled');
      if (this.installation.state !== 'available') return { ...base, state: this.installation.state };
      const binary = this.installation.binary;
      const observed = await inspectRepository(repository, true);
      if (!observed) return { ...base, state: 'not-repository' };
      const execute = async (command: 'identity' | 'tracked' | 'status'): Promise<Buffer> => {
        if (!await this.authorized(repository)) throw new GitStatusError('permission-denied');
        const before = await inspectRepository(repository, false);
        if (!before || before.gitIdentity !== observed.gitIdentity || before.configHash !== observed.configHash) throw new GitStatusError('root-changed');
        const result = await runGitStatusCommand(binary, repository.root, command, signal);
        const after = await inspectRepository(repository, command === 'status');
        if (!after || after.gitIdentity !== observed.gitIdentity || after.configHash !== observed.configHash) throw new GitStatusError('root-changed');
        if (!await this.authorized(repository)) throw new GitStatusError('permission-denied');
        return result;
      };
      const identity = decode(await execute('identity')).trimEnd().split(/\r?\n/);
      if (identity.length !== 2 || !equalPath(resolve(identity[0]!), repository.root) || !equalPath(resolve(identity[1]!), join(repository.root, '.git'))) throw new GitStatusError('root-changed');
      const tracked = decode(await execute('tracked'));
      if (tracked && !tracked.endsWith('\0')) throw new GitStatusError('invalid-output');
      const paths = tracked ? tracked.slice(0, -1).split('\0') : [];
      if (paths.some((path) => !validGitRelativePath(path))) throw new GitStatusError('invalid-output');
      const excludedTrackedCount = paths.filter(protectedGitPath).length;
      const status = parseGitStatus(await execute('status'));
      return { ...base, ...status, state: 'ready', version: binary.version, excludedTrackedCount,
        diagnostics: excludedTrackedCount ? ['PROTECTED_TRACKED_FILES'] : [] };
    } catch (error) {
      const states = ['not-installed', 'unverified-binary', 'unsupported-repository', 'root-unavailable', 'root-changed', 'permission-denied', 'cancelled', 'timeout', 'output-limit', 'invalid-output'];
      const state = error instanceof GitStatusError && states.includes(error.code) ? error.code as GitRepositoryStatus['state'] : 'failed';
      return { ...base, state, diagnostics: ['GIT_STATUS_' + state.replaceAll('-', '_').toUpperCase()] };
    }
  }
}

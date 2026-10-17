import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, open, rename, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { GitApplied, GitProjectView, GitReviewInput, GitReviewView, GitDiffView } from '../shared/git-operations.ts';
import { GitStatusError, runGitVersionCommand, secretLike, validGitBranch, type GitInstallation, type GitVersionCommand, type VerifiedGitBinary } from './git-process.ts';
import { LocalGitStatusAdapter, type HostGitRepository } from './git-status.ts';
import { protectedGitPath, validGitRelativePath } from './git-status-policy.ts';

export type LocalGitCapability = 'git.status' | 'git.diff' | 'git.stage' | 'git.commit' | 'git.restore' | 'git.branch';
export interface GitRestoreFile { path: string; bytes: Uint8Array | null; expectedHash: string | null; }
export interface GitRestorePlan { paths: readonly string[]; images: readonly { path: string; bytes: Uint8Array | null }[]; snapshotId: string; apply(): Promise<void>; }
export interface GitVersionsHost {
  authorize(capability: LocalGitCapability, stage: 'prepare' | 'apply'): Promise<boolean>;
  hasDirtyBuffers(): Promise<boolean>;
  prepareRestore(operationId: string, files: readonly GitRestoreFile[]): Promise<GitRestorePlan>;
}
interface Review {
  view: GitReviewView; input: GitReviewInput; indexHash: string | null; files: Map<string, Buffer | null>;
  head: string | null; branch: string | null; expires: number; restore?: GitRestorePlan;
}
const digest = (bytes: Uint8Array | null): string | null => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const capability = (kind: GitReviewInput['kind']): LocalGitCapability => kind === 'commit' ? 'git.commit' : kind === 'branch' ? 'git.branch' : kind.includes('restore') ? 'git.restore' : 'git.stage';
const need = (condition: unknown, code: string): void => { if (!condition) throw new GitStatusError(code); };
const safePath = (path: string): string => { need(validGitRelativePath(path) && !protectedGitPath(path) && path.split('/').every((part) => !/[. ]$/.test(part) && !/[\x00-\x1f<>"|?*]/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'protected-path'); return path; };
async function bytesAt(path: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(path); need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024, 'unsupported-file');
    const bytes = await readFile(path), after = await lstat(path);
    need(stat.ino === after.ino && stat.dev === after.dev && stat.mtimeMs === after.mtimeMs && stat.size === after.size, 'review-conflict'); return bytes;
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
}
function safeContent(bytes: Uint8Array | null): void {
  if (!bytes) return;
  need(!secretLike(Buffer.from(bytes).toString('utf8')), 'secret-detected');
  need(!Buffer.from(bytes).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'), 'lfs-unavailable');
}
function diffView(path: string, diff: string, bytes: Uint8Array | null): GitDiffView {
  safeContent(bytes); need(!secretLike(diff), 'secret-detected');
  const binary = !!bytes?.includes(0) || diff.includes('Binary files ');
  if (binary) return { path, binary: true, text: `Binario · ${bytes?.length ?? 0} bytes · sha256 ${digest(bytes)}`, hunks: [] };
  const parts = diff.split(/(?=^@@ )/m);
  const hunks = parts.slice(1).map((part) => ({ id: digest(Buffer.from(path + '\0' + part))!, text: part }));
  return { path, binary: false, text: diff || (bytes ? `--- /dev/null\n+++ ${path}\n${text(bytes).split('\n').map((line) => '+' + line).join('\n')}` : 'Archivo eliminado'), hunks };
}
function restoreDiff(path: string, before: Uint8Array | null, after: Uint8Array | null): GitDiffView {
  safeContent(before); safeContent(after);
  return diffView(path, `--- actual/${path}\n+++ versión/${path}\n${before === null ? '' : textOrBinary(before).split('\n').map((line) => '-' + line).join('\n')}\n${after === null ? '(eliminar)\n' : textOrBinary(after).split('\n').map((line) => '+' + line).join('\n')}`, after);
}

/** One instance per host project session. Renderer receives expiring reviews, never prepared writes. */
export class LocalGitVersions {
  private readonly adapter: LocalGitStatusAdapter;
  private readonly reviews = new Map<string, Review>();
  private readonly returns = new Map<string, { files: GitRestoreFile[]; snapshotId: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly installation: GitInstallation, private readonly repository: HostGitRepository, private readonly host: GitVersionsHost) {
    this.adapter = new LocalGitStatusAdapter(installation, { authorize: () => host.authorize('git.status', 'prepare') });
  }
  static async open(installation: GitInstallation, repository: HostGitRepository, host: GitVersionsHost): Promise<LocalGitVersions> {
    const service = new LocalGitVersions(installation, repository, host); await service.adapter.bind(repository); return service;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.catch(() => undefined); return next; }
  private async allow(cap: LocalGitCapability, stage: 'prepare' | 'apply' = 'prepare'): Promise<void> {
    need(await this.host.authorize(cap, stage), 'permission-denied');
  }
  private binary(): VerifiedGitBinary { if (this.installation.state !== 'available') throw new GitStatusError(this.installation.state); return this.installation.binary; }
  private async run(command: GitVersionCommand): Promise<Buffer> {
    await this.status();
    try { return await runGitVersionCommand(this.binary(), this.repository.root, command); }
    catch (error) { if (error instanceof GitStatusError && error.code === 'failed') throw new GitStatusError(`git-${command.kind}-failed`); throw error; }
  }
  private async status() { const status = await this.adapter.status(this.repository.repositoryId); need(status.state === 'ready', status.state); return status; }
  private async quiet(): Promise<void> {
    need(!await this.host.hasDirtyBuffers(), 'unsaved-changes');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
      try { await lstat(join(this.repository.root, '.git', marker)); throw new GitStatusError('operation-in-progress'); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
  }
  private async filters(path: string): Promise<void> {
    const localAttributes = await bytesAt(join(this.repository.root, '.git/info/attributes'));
    need(!localAttributes || !/\bfilter\s*=/.test(localAttributes.toString('utf8')), 'lfs-or-filter-unavailable');
    let directory = dirname(join(this.repository.root, safePath(path)));
    while (true) {
      const bytes = await bytesAt(join(directory, '.gitattributes'));
      need(!bytes || !/\bfilter\s*=/.test(bytes.toString('utf8')), 'lfs-or-filter-unavailable');
      if (directory === this.repository.root) break;
      need(!relative(this.repository.root, directory).startsWith('..'), 'protected-path'); directory = dirname(directory);
    }
  }
  private async blob(path: string, commit?: string): Promise<Buffer | null> {
    const line = text(await this.run(commit ? { kind: 'entry', commit, path } : { kind: 'index-entry', path }));
    if (!line) return null;
    const match = /^(100644|100755) (?:blob )?([a-f0-9]{40})(?: 0)?\t[^\0]+\0$/.exec(line);
    need(match, 'unsupported-file'); return this.run({ kind: 'blob', oid: match![2]! });
  }
  load(): Promise<GitProjectView> { return this.serial(async () => {
    const status = await this.adapter.status(this.repository.repositoryId);
    if (status.state !== 'ready') return { root: this.repository.root, status, branches: [], log: [] };
    await this.allow('git.diff');
    const branches = text(await this.run({ kind: 'branches' })).trimEnd().split('\n').filter(Boolean).map((line) => { const [name, oid] = line.split('\0'); return { name: name!, oid: oid! }; });
    const log = status.unborn ? [] : text(await this.run({ kind: 'log' })).trimEnd().split('\n').filter(Boolean).map((line) => { const [oid, subject] = line.split('\0'); return { oid: oid!, subject: secretLike(subject ?? '') ? '[mensaje oculto: posible secreto]' : subject ?? '' }; });
    return { root: this.repository.root, status, branches, log };
  }); }
  cancel(token: string): void { this.reviews.delete(token); }
  review(input: GitReviewInput): Promise<GitReviewView> { return this.serial(async () => {
    await this.allow(capability(input.kind)); await this.allow('git.diff'); await this.quiet();
    const status = await this.status(); need(!status.entries.some((entry) => entry.kind === 'unmerged'), 'unresolved-conflict');
    const index = await bytesAt(join(this.repository.root, '.git/index'));
    let paths = [...new Set(input.paths ?? [])], targetCommit = input.commit ?? status.head;
    paths.forEach(safePath);
    need(new Set(paths.map((path) => path.toLowerCase())).size === paths.length, 'invalid-selection');
    if (input.kind === 'stage' || input.kind === 'unstage') need(paths.every((path) => status.entries.some((entry) => entry.path === path)), 'invalid-selection');
    let undo: { files: GitRestoreFile[]; snapshotId: string } | undefined;
    if (input.kind === 'commit') {
      need(status.excludedTrackedCount === 0, 'protected-tracked-files');
      need(input.message?.trim() && input.name?.trim() && input.email?.trim() && !secretLike(input.message), 'invalid-commit');
      need(status.branch, 'detached-head'); paths = status.entries.filter((entry) => entry.index !== '.' && entry.kind !== 'untracked').map((entry) => entry.path);
    }
    if (input.kind === 'branch') { need(status.head && status.branch && input.branch && validGitBranch(input.branch), 'invalid-branch'); paths = []; }
    if (input.kind === 'undo-restore') { undo = this.returns.get(input.undoToken ?? ''); need(undo, 'return-point-missing'); paths = undo!.files.map((file) => file.path); }
    need(paths.length <= 128 && (paths.length > 0 || input.kind === 'branch'), 'empty-selection');
    const files = new Map<string, Buffer | null>(), diffs: GitDiffView[] = [], restoreFiles: GitRestoreFile[] = [];
    let reviewBytes = 0;
    for (const path of paths) {
      safePath(path); await this.filters(path);
      const current = await bytesAt(join(this.repository.root, path)); safeContent(current); files.set(path, current);
      let source: Buffer | null = current;
      if (input.kind.includes('restore')) {
        need(this.repository.kind === 'a3-project', 'external-restore-denied');
        if (undo) { const saved = undo.files.find((file) => file.path === path)!; need(digest(current) === saved.expectedHash, 'review-conflict'); source = saved.bytes === null ? null : Buffer.from(saved.bytes); }
        else { need(targetCommit && /^[a-f0-9]{40}$/.test(targetCommit), 'invalid-object'); source = await this.blob(path, targetCommit!); }
        safeContent(source); restoreFiles.push({ path, bytes: source, expectedHash: digest(current) });
        diffs.push(restoreDiff(path, current, source));
      } else {
        const cached = input.kind === 'commit' || input.kind === 'unstage';
        if (cached) { source = await this.blob(path); safeContent(source); }
        const patch = text(await this.run({ kind: 'diff', cached, path }));
        diffs.push(diffView(path, patch, source));
      }
      reviewBytes += (current?.length ?? 0) + (source === current ? 0 : source?.length ?? 0) + Buffer.byteLength(diffs.at(-1)!.text);
      need(reviewBytes <= 32 * 1024 * 1024, 'review-limit');
    }
    let restore: GitRestorePlan | undefined;
    if (restoreFiles.length) {
      restore = await this.host.prepareRestore(randomUUID(), restoreFiles);
      for (const path of restore.paths) if (!files.has(path)) { safePath(path); files.set(path, await bytesAt(join(this.repository.root, path))); }
      diffs.splice(0, diffs.length, ...restore.images.map((image) => restoreDiff(image.path, files.get(image.path) ?? null, image.bytes)));
      paths = [...restore.paths];
    }
    need([...files.values()].reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0) + diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.text), 0) <= 32 * 1024 * 1024, 'review-limit');
    const token = randomUUID();
    const view: GitReviewView = { token, root: this.repository.root, kind: input.kind, branch: status.branch ?? null, paths, diffs,
      ...(input.message ? { message: input.message } : {}), ...(input.branch ? { targetBranch: input.branch } : {}), ...(targetCommit && input.kind === 'restore' ? { targetCommit } : {}),
      warnings: input.kind.includes('restore') ? ['Se crea un snapshot local y nuevas revisiones mediante el journal A3.', 'El índice Git no cambia.'] : [] };
    for (const [key, review] of this.reviews) if (review.expires < Date.now()) this.reviews.delete(key);
    need(this.reviews.size < 32, 'review-limit');
    this.reviews.set(token, { view, input: structuredClone(input), indexHash: digest(index), files, head: status.head ?? null, branch: status.branch ?? null, expires: Date.now() + 300_000, restore }); return view;
  }); }
  apply(token: string, hunkIds?: readonly string[]): Promise<GitApplied> { return this.serial(async () => {
    const review = this.reviews.get(token); need(review && review.expires >= Date.now(), 'review-expired');
    const r = review!; await this.allow(capability(r.input.kind), 'apply'); await this.quiet();
    const verify = async (): Promise<void> => {
      await this.quiet();
      const status = await this.status(); need(status.head === r.head && status.branch === r.branch && !status.entries.some((entry) => entry.kind === 'unmerged'), 'review-conflict');
      need(digest(await bytesAt(join(this.repository.root, '.git/index'))) === r.indexHash, 'review-conflict');
      for (const [path, before] of r.files) { await this.filters(path); need(digest(await bytesAt(join(this.repository.root, path))) === digest(before), 'review-conflict'); }
    };
    await verify();
    if (r.restore) {
      await r.restore.apply();
      const undoToken = randomUUID(), files: GitRestoreFile[] = [];
      for (const [path, before] of r.files) files.push({ path, bytes: before, expectedHash: digest(r.restore.images.find((image) => image.path === path)!.bytes) });
      this.returns.set(undoToken, { files, snapshotId: r.restore.snapshotId }); this.reviews.delete(token);
      if (r.input.undoToken) this.returns.delete(r.input.undoToken);
      if (this.returns.size > 8) this.returns.delete(this.returns.keys().next().value!);
      return { applied: true, kind: r.input.kind, snapshotId: r.restore.snapshotId, undoToken };
    }
    const lockPath = join(this.repository.root, '.git/index.lock'), alternate = join(this.repository.root, '.git', `a3-index-${randomUUID()}`);
    let lock: Awaited<ReturnType<typeof open>>;
    try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new GitStatusError('repository-busy'); }
    let promoted = false;
    try {
      await verify();
      const index = await bytesAt(join(this.repository.root, '.git/index'));
      if (index) { const temporary = await open(alternate, 'wx', 0o600); try { await temporary.writeFile(index); } finally { await temporary.close(); } }
      let committed: string | undefined;
      if (r.input.kind === 'stage' || r.input.kind === 'unstage') {
        const diff = r.view.diffs[0], partial = hunkIds && diff && hunkIds.length !== diff.hunks.length;
        if (hunkIds) need(r.input.kind === 'stage' && r.view.diffs.length === 1 && hunkIds.length && new Set(hunkIds).size === hunkIds.length && hunkIds.every((id) => diff!.hunks.some((hunk) => hunk.id === id)), 'invalid-hunks');
        if (partial) {
          const header = diff.text.split(/^@@ /m)[0]!;
          await this.run({ kind: 'patch', patch: header + diff.hunks.filter((hunk) => hunkIds.includes(hunk.id)).map((hunk) => hunk.text).join(''), indexFile: alternate });
        } else await this.run({ kind: r.input.kind, paths: r.view.paths, indexFile: alternate, unborn: !r.head });
        await verify(); await this.allow('git.stage', 'prepare');
        const next = await bytesAt(alternate); need(next, 'invalid-index');
        await lock.writeFile(next!); await lock.sync(); await lock.close();
        await rename(lockPath, join(this.repository.root, '.git/index')); promoted = true;
      } else if (r.input.kind === 'commit') {
        const tree = text(await this.run({ kind: 'tree', indexFile: alternate })).trim();
        committed = text(await this.run({ kind: 'commit-object', tree, parent: r.head, message: r.input.message!, name: r.input.name!, email: r.input.email!, indexFile: alternate })).trim();
        await verify(); await this.allow('git.commit', 'prepare');
        await this.run({ kind: 'publish', branch: r.branch!, previous: r.head, next: committed });
      } else if (r.input.kind === 'branch') { await verify(); await this.allow('git.branch', 'prepare'); await this.run({ kind: 'branch', branch: r.input.branch!, current: r.branch!, head: r.head! }); }
      this.reviews.delete(token); return { applied: true, kind: r.input.kind, ...(committed ? { commit: committed } : {}) };
    } finally {
      if (!promoted) { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }); }
      await rm(alternate, { force: true }); await rm(alternate + '.lock', { force: true });
    }
  }); }
}
function textOrBinary(bytes: Uint8Array): string { try { return bytes.includes(0) ? `(binario · ${bytes.length} bytes)` : text(bytes); } catch { return `(binario · ${bytes.length} bytes)`; } }

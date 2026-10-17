import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitAutomationPolicy, GitAutomationRun } from '../shared/git-automation.ts';
import type { GitApplied, GitDiffView, GitProjectView, GitReviewInput, GitReviewView } from '../shared/git-operations.ts';
import { githubDestination, GithubError } from './github-api.ts';
import { GitStatusError, secretLike, validGitBranch } from './git-process.ts';
import { protectedGitPath, validGitRelativePath } from './git-status-policy.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const now = (): number => Date.now();
const validMessageTemplate = (value: string): boolean => {
  const placeholders = [...value.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);
  return !/[{}]/.test(value.replace(/\{[^{}]*\}/g, '')) && placeholders.every((name) => ['date', 'branch', 'files', 'count'].includes(name ?? ''));
};
const DEFAULT_POLICY: GitAutomationPolicy = Object.freeze({ schemaVersion: '1.0.0', mode: 'manual', idleMs: 300_000,
  branch: 'main', paths: [], messageTemplate: 'chore: update {files}', authorName: '', authorEmail: '', pushAfterCommit: false });

export class GitAutomationError extends Error { constructor(readonly code: string) { super(`A3 Git automation: ${code}`); } }

export interface GitAutomationPort {
  load(): Promise<GitProjectView>;
  fingerprint(paths: readonly string[]): Promise<string>;
  review(input: GitReviewInput): Promise<GitReviewView>;
  apply(token: string): Promise<GitApplied>;
  cancel(token: string): void;
  commitMessage(oid: string): Promise<string>;
}
export interface GitAutomationPublisher {
  check(destinationUrl: string, branch: string, head?: string): Promise<void>;
  publish(destinationUrl: string, branch: string, head: string, signal?: AbortSignal): Promise<void>;
}
interface PersistedRun {
  state: 'waiting' | 'committing' | 'push-pending' | 'committed' | 'pushed' | 'blocked';
  runId: string;
  policyHash: string;
  fingerprint: string;
  baseHead: string | null;
  branch: string;
  paths: string[];
  message: string;
  destinationUrl?: string;
  commit?: string;
  code?: string;
  updatedAt: number;
  stableSince?: number;
  diffs?: GitDiffView[];
}
interface AutomationFile { schemaVersion: '1.0.0'; bindingHash: string; policy: GitAutomationPolicy; run?: PersistedRun; }
export interface StoredAutomation { policy: GitAutomationPolicy; run?: PersistedRun; corrupt: boolean; }

export function defaultGitAutomationPolicy(branch = 'main'): GitAutomationPolicy { return { ...DEFAULT_POLICY, branch }; }

export function validateGitAutomationPolicy(value: unknown): GitAutomationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitAutomationError('invalid-policy');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((key) => !['schemaVersion', 'mode', 'idleMs', 'branch', 'paths', 'messageTemplate', 'authorName', 'authorEmail', 'pushAfterCommit', 'destinationUrl'].includes(key)) ||
      p.schemaVersion !== '1.0.0' || !['manual', 'auto-after-idle'].includes(String(p.mode)) || !Number.isSafeInteger(p.idleMs) || Number(p.idleMs) < 30_000 || Number(p.idleMs) > 86_400_000 ||
      typeof p.branch !== 'string' || !validGitBranch(p.branch) || !Array.isArray(p.paths) || p.paths.length > 128 || p.paths.some((path) => typeof path !== 'string' || path.length > 1024 || !validGitRelativePath(path) || protectedGitPath(path)) ||
      new Set((p.paths as string[]).map((path) => path.toLowerCase())).size !== p.paths.length || typeof p.messageTemplate !== 'string' || p.messageTemplate.trim().length === 0 || p.messageTemplate.length > 512 ||
      !validMessageTemplate(p.messageTemplate) || typeof p.authorName !== 'string' || p.authorName.length > 256 || /[\x00-\x1f<>]/.test(p.authorName) || (p.mode === 'auto-after-idle' && !p.authorName.trim()) ||
      typeof p.authorEmail !== 'string' || p.authorEmail.length > 320 || /[\x00-\x1f]/.test(p.authorEmail) || (p.mode === 'auto-after-idle' && !/^[^\s<>@]+@[^\s<>@]+$/.test(p.authorEmail)) ||
      typeof p.pushAfterCommit !== 'boolean' || p.mode === 'auto-after-idle' && (p.paths as string[]).length === 0 || p.pushAfterCommit && p.mode !== 'auto-after-idle' ||
      p.destinationUrl !== undefined && typeof p.destinationUrl !== 'string') throw new GitAutomationError('invalid-policy');
  let destinationUrl: string | undefined;
  if (p.pushAfterCommit || p.destinationUrl !== undefined) {
    try { destinationUrl = githubDestination(String(p.destinationUrl)).url; }
    catch { throw new GitAutomationError('invalid-destination'); }
  }
  return { schemaVersion: '1.0.0', mode: p.mode as GitAutomationPolicy['mode'], idleMs: Number(p.idleMs), branch: p.branch as string,
    paths: [...p.paths as string[]], messageTemplate: p.messageTemplate as string, authorName: p.authorName as string, authorEmail: p.authorEmail as string,
    pushAfterCommit: p.pushAfterCommit as boolean, ...(destinationUrl === undefined ? {} : { destinationUrl }) };
}

function validRun(value: unknown): value is PersistedRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const allowedKeys = ['state', 'runId', 'policyHash', 'fingerprint', 'baseHead', 'branch', 'paths', 'message', 'destinationUrl', 'commit', 'code', 'updatedAt', 'stableSince', 'diffs'];
  const validDiff = (item: unknown): item is GitDiffView => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const diff = item as Record<string, unknown>;
    return Object.keys(diff).every((key) => ['path', 'text', 'binary', 'hunks'].includes(key)) && typeof diff.path === 'string' && validGitRelativePath(diff.path) && !protectedGitPath(diff.path) &&
      typeof diff.text === 'string' && diff.text.length <= 2_100_000 && typeof diff.binary === 'boolean' && Array.isArray(diff.hunks) && diff.hunks.length <= 256 &&
      diff.hunks.every((hunk) => !!hunk && typeof hunk === 'object' && typeof (hunk as Record<string, unknown>).id === 'string' && /^[a-f0-9]{64}$/.test(String((hunk as Record<string, unknown>).id)) &&
        typeof (hunk as Record<string, unknown>).text === 'string' && ((hunk as Record<string, unknown>).text as string).length <= 2_100_000);
  };
  let destinationValid = true;
  if (r.destinationUrl !== undefined) { try { destinationValid = typeof r.destinationUrl === 'string' && githubDestination(r.destinationUrl).url === r.destinationUrl; } catch { destinationValid = false; } }
  return Object.keys(r).every((key) => allowedKeys.includes(key)) && ['waiting', 'committing', 'push-pending', 'committed', 'pushed', 'blocked'].includes(String(r.state)) && typeof r.runId === 'string' && /^[a-f0-9-]{36}$/i.test(r.runId) &&
    typeof r.policyHash === 'string' && /^[a-f0-9]{64}$/.test(r.policyHash) && typeof r.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.fingerprint) &&
    (r.baseHead === null || typeof r.baseHead === 'string' && /^[a-f0-9]{40}$/.test(r.baseHead)) && typeof r.branch === 'string' && validGitBranch(r.branch) &&
    Array.isArray(r.paths) && r.paths.length > 0 && r.paths.length <= 128 && r.paths.every((path) => typeof path === 'string' && validGitRelativePath(path) && !protectedGitPath(path)) &&
    typeof r.message === 'string' && r.message.length <= 4096 && !secretLike(r.message) && destinationValid && (r.destinationUrl === undefined || typeof r.destinationUrl === 'string' && r.destinationUrl.length <= 200) &&
    (r.commit === undefined || typeof r.commit === 'string' && /^[a-f0-9]{40}$/.test(r.commit)) && (r.code === undefined || typeof r.code === 'string' && /^[a-z][a-z0-9-]{1,80}$/.test(r.code)) &&
    Number.isSafeInteger(r.updatedAt) && (r.stableSince === undefined || Number.isSafeInteger(r.stableSince)) && (r.diffs === undefined || Array.isArray(r.diffs) && r.diffs.length <= 128 && r.diffs.every(validDiff));
}

/** Per-repository settings and recovery markers live in host state, never in the portable repository. */
export class GitAutomationStore {
  constructor(private readonly stateDirectory: string) {}
  bindingHash(binding: string): string { return sha256(binding); }
  private path(bindingHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(bindingHash)) throw new GitAutomationError('invalid-binding');
    return join(this.stateDirectory, 'git-automation', `${bindingHash}.json`);
  }
  async read(bindingHash: string, branch = 'main'): Promise<StoredAutomation> {
    try {
      const bytes = await readFile(this.path(bindingHash));
      if (bytes.length > 1_048_576) return { policy: defaultGitAutomationPolicy(branch), corrupt: true };
      const parsed = JSON.parse(bytes.toString('utf8')) as AutomationFile;
      const policy = validateGitAutomationPolicy(parsed.policy);
      if (parsed.schemaVersion !== '1.0.0' || parsed.bindingHash !== bindingHash || parsed.run !== undefined && !validRun(parsed.run)) return { policy: defaultGitAutomationPolicy(branch), corrupt: true };
      return { policy, ...(parsed.run ? { run: parsed.run } : {}), corrupt: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { policy: defaultGitAutomationPolicy(branch), corrupt: false };
      return { policy: defaultGitAutomationPolicy(branch), corrupt: true };
    }
  }
  async write(bindingHash: string, policy: GitAutomationPolicy, run?: PersistedRun): Promise<void> {
    const normalized = validateGitAutomationPolicy(policy), target = this.path(bindingHash), directory = join(this.stateDirectory, 'git-automation');
    await mkdir(directory, { recursive: true, mode: 0o700 }); const temp = join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schemaVersion: '1.0.0', bindingHash, policy: normalized, ...(run ? { run } : {}) } satisfies AutomationFile)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => undefined); }
  }
  async writeRun(bindingHash: string, policy: GitAutomationPolicy, run: PersistedRun): Promise<void> { await this.write(bindingHash, policy, run); }
}

const renderMessage = (policy: GitAutomationPolicy, paths: readonly string[], at: number): string => policy.messageTemplate
  .replaceAll('{date}', new Date(at).toISOString().slice(0, 10)).replaceAll('{branch}', policy.branch)
  .replaceAll('{files}', paths.map((path) => path.split('/').at(-1)).join(', ')).replaceAll('{count}', String(paths.length)).trim();
const publicRun = (run: PersistedRun): GitAutomationRun => ({ state: run.state, ...(run.code ? { code: run.code } : {}), branch: run.branch, files: run.paths,
  ...(run.commit ? { commit: run.commit } : {}), updatedAt: run.updatedAt, ...(run.diffs ? { diffs: run.diffs } : {}) });
const automationFailureCode = (error: unknown): string => error instanceof GitStatusError || error instanceof GithubError || error instanceof GitAutomationError
  ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'automation-failed';

function ensureStatus(view: GitProjectView, policy: GitAutomationPolicy): string[] {
  if (view.status.state !== 'ready') throw new GitAutomationError(view.status.state === 'permission-denied' ? 'permission-denied' : `repository-${view.status.state}`);
  if (view.status.branch !== policy.branch) throw new GitAutomationError('branch-mismatch');
  if (view.status.entries.some((entry) => entry.kind === 'unmerged')) throw new GitAutomationError('unresolved-conflict');
  const selected = new Set(policy.paths), changed = view.status.entries.filter((entry) => selected.has(entry.path)).map((entry) => entry.path);
  if (view.status.entries.some((entry) => entry.index !== '.' && !selected.has(entry.path))) throw new GitAutomationError('unselected-staged-changes');
  return [...new Set(changed)];
}

/** One policy batch stages only its explicit file set; commit retry after success sees no selected changes. */
export async function runGitAutomationBatch(input: { bindingHash: string; policy: GitAutomationPolicy; stored?: PersistedRun; git: GitAutomationPort;
  publisher?: GitAutomationPublisher; pushAvailable: boolean; capabilities: { stage: boolean; commit: boolean; push: boolean }; now?: number;
  persist?: (record: PersistedRun) => Promise<void>; signal?: AbortSignal }): Promise<{ run: GitAutomationRun; record?: PersistedRun }> {
  const policy = validateGitAutomationPolicy(input.policy), timestamp = input.now ?? now(), policyHash = sha256(JSON.stringify(policy));
  const saveBlocked = async (code: string, files: string[] = [], fingerprint = sha256('')) => {
    const prior = input.stored;
    const record: PersistedRun = prior?.commit && prior.state !== 'committing' ? { ...prior, state: 'blocked', code, updatedAt: timestamp } : {
      state: 'blocked', runId: prior?.runId ?? randomUUID(), policyHash, fingerprint, baseHead: prior?.baseHead ?? null, branch: policy.branch,
      paths: files.length ? files : [...policy.paths], message: prior?.message ?? '', ...(policy.destinationUrl ? { destinationUrl: policy.destinationUrl } : {}), ...(prior?.commit ? { commit: prior.commit } : {}), code, updatedAt: timestamp
    };
    await input.git.cancel(prior?.runId ?? '');
    return { run: publicRun(record), record };
  };
  if (policy.mode !== 'auto-after-idle') return { run: { state: 'idle', files: [], updatedAt: timestamp } };
  if (!input.capabilities.stage) return saveBlocked('stage-permission-denied');
  if (!input.capabilities.commit) return saveBlocked('commit-permission-denied');
  if (policy.pushAfterCommit && !input.pushAvailable) return saveBlocked('mounted-push-unavailable');
  if (policy.pushAfterCommit && !input.capabilities.push) return saveBlocked('push-permission-denied');
  if (policy.pushAfterCommit && !input.publisher) return saveBlocked('authorization-unavailable');

  let view: GitProjectView;
  try { view = await input.git.load(); } catch (error) { return saveBlocked(automationFailureCode(error)); }
  let paths: string[];
  try { paths = ensureStatus(view, policy); } catch (error) { return saveBlocked(automationFailureCode(error)); }
  if (!paths.length) {
    const prior = input.stored;
    if (prior?.state === 'committing') {
      if (view.status.head && view.status.head !== prior.baseHead) {
        try {
          const message = await input.git.commitMessage(view.status.head);
          if (message.includes(`A3-Automation-Id: ${prior.runId}`)) {
            const recovered: PersistedRun = { ...prior, state: policy.pushAfterCommit ? 'push-pending' : 'committed', commit: view.status.head, updatedAt: timestamp };
            await input.git.cancel(prior.runId);
            return finishOrPush(input, policy, recovered, timestamp);
          }
        } catch { /* A changed head without our marker is an unresolved concurrent write. */ }
        return saveBlocked('head-changed-during-automation', [], prior.fingerprint);
      }
      if (view.status.head === prior.baseHead) return { run: { state: 'waiting', branch: prior.branch, files: prior.paths, updatedAt: timestamp } };
    }
    if (prior?.state === 'push-pending' || prior?.state === 'blocked' && prior.commit) return { run: publicRun(prior), record: prior };
    if (prior && ['committed', 'pushed', 'blocked'].includes(prior.state)) return { run: publicRun(prior), record: prior };
    return { run: { state: 'idle', branch: policy.branch, files: [], updatedAt: timestamp } };
  }
  let fingerprint: string;
  try { fingerprint = await input.git.fingerprint(paths); } catch (error) { return saveBlocked(automationFailureCode(error), paths); }
  const prior = input.stored;
  if (prior?.state === 'blocked' && !prior.commit && prior.fingerprint === fingerprint && prior.policyHash === policyHash) return { run: publicRun(prior), record: prior };
  if (prior?.state === 'committing' && (prior.fingerprint !== fingerprint || prior.policyHash !== policyHash)) {
    const blocked: PersistedRun = { ...prior, state: 'blocked', code: 'automation-recovery-conflict', updatedAt: timestamp };
    return { run: publicRun(blocked), record: blocked };
  }
  const stable = prior?.state === 'waiting' && prior.fingerprint === fingerprint && prior.policyHash === policyHash && prior.branch === policy.branch && JSON.stringify(prior.paths) === JSON.stringify(paths) ? prior : undefined;
  if (prior?.state !== 'committing' && (!stable || timestamp - (stable.stableSince ?? stable.updatedAt) < policy.idleMs)) {
    const waiting: PersistedRun = { state: 'waiting', runId: stable?.runId ?? randomUUID(), policyHash, fingerprint, baseHead: view.status.head ?? null,
      branch: policy.branch, paths, message: stable?.message || renderMessage(policy, paths, timestamp), ...(policy.destinationUrl ? { destinationUrl: policy.destinationUrl } : {}),
      stableSince: stable?.stableSince ?? timestamp, updatedAt: timestamp };
    return { run: publicRun(waiting), record: waiting };
  }
  if (policy.pushAfterCommit) {
    try { await input.publisher!.check(policy.destinationUrl!, policy.branch, view.status.head ?? undefined); }
    catch (error) { return saveBlocked(automationFailureCode(error), paths, fingerprint); }
  }
  if (input.signal?.aborted) return saveBlocked('cancelled', paths, fingerprint);
  const runId = prior?.state === 'committing' && prior.fingerprint === fingerprint && prior.policyHash === policyHash ? prior.runId : stable!.runId;
  const messageBody = prior?.state === 'committing' && prior.fingerprint === fingerprint && prior.policyHash === policyHash ? prior.message.replace(/\n\nA3-Automation-Id: [a-f0-9-]{36}$/i, '') : stable!.message;
  if (!messageBody || messageBody.length > 3800 || secretLike(messageBody)) return saveBlocked('invalid-commit-message', paths, fingerprint);
  const record: PersistedRun = { state: 'committing', runId, policyHash, fingerprint, baseHead: prior?.state === 'committing' && prior.runId === runId ? prior.baseHead : view.status.head ?? null,
    branch: policy.branch, paths, message: `${messageBody}\n\nA3-Automation-Id: ${runId}`, ...(policy.destinationUrl ? { destinationUrl: policy.destinationUrl } : {}), updatedAt: timestamp };
  const stageInput: GitReviewInput = { kind: 'stage', paths };
  let stage: GitReviewView | undefined, commitReview: GitReviewView | undefined;
  try {
    await input.persist?.(record);
    stage = await input.git.review(stageInput);
    if (Buffer.byteLength(stage.diffs.map((diff) => diff.text).join('\n')) > 2_000_000) throw new GitAutomationError('automation-diff-limit');
    const staged = await input.git.apply(stage.token);
    if (!staged.applied) throw new GitAutomationError('stage-failed');
    if (input.signal?.aborted) throw new GitAutomationError('cancelled');
    commitReview = await input.git.review({ kind: 'commit', message: record.message, name: policy.authorName, email: policy.authorEmail });
    if (commitReview.paths.some((path) => !policy.paths.includes(path)) || Buffer.byteLength(commitReview.diffs.map((diff) => diff.text).join('\n')) > 2_000_000) throw new GitAutomationError('automation-diff-limit');
    record.diffs = [...structuredClone(commitReview.diffs)]; record.updatedAt = timestamp;
    await input.persist?.(record);
    if (input.signal?.aborted) throw new GitAutomationError('cancelled');
    const applied = await input.git.apply(commitReview.token);
    if (!applied.applied || !applied.commit) throw new GitAutomationError('commit-failed');
    const committed: PersistedRun = { ...record, state: policy.pushAfterCommit ? 'push-pending' : 'committed', commit: applied.commit, updatedAt: timestamp };
    await input.persist?.(committed);
    await input.git.cancel(stage.token); await input.git.cancel(commitReview.token);
    return finishOrPush(input, policy, committed, timestamp);
  } catch (error) {
    if (stage) input.git.cancel(stage.token); if (commitReview) input.git.cancel(commitReview.token);
    const blocked: PersistedRun = { ...record, state: 'blocked', code: automationFailureCode(error), updatedAt: timestamp };
    await input.persist?.(blocked);
    return { run: publicRun(blocked), record: blocked };
  }
}

async function finishOrPush(input: { bindingHash: string; policy: GitAutomationPolicy; stored?: PersistedRun; git: GitAutomationPort; publisher?: GitAutomationPublisher;
  pushAvailable: boolean; capabilities: { stage: boolean; commit: boolean; push: boolean }; now?: number; signal?: AbortSignal }, policy: GitAutomationPolicy, record: PersistedRun, timestamp: number) {
  if (!policy.pushAfterCommit || record.state === 'committed' || record.state === 'pushed') return { run: publicRun(record), record };
  if (!record.commit || !record.destinationUrl || record.destinationUrl !== policy.destinationUrl || record.branch !== policy.branch || record.policyHash !== sha256(JSON.stringify(policy))) {
    const blocked = { ...record, state: 'blocked' as const, code: 'automation-policy-changed', updatedAt: timestamp }; return { run: publicRun(blocked), record: blocked };
  }
  if (!input.pushAvailable || !input.capabilities.push || !input.publisher) {
    const code = !input.pushAvailable ? 'mounted-push-unavailable' : !input.capabilities.push ? 'push-permission-denied' : 'authorization-unavailable';
    const blocked = { ...record, state: 'blocked' as const, code, updatedAt: timestamp }; return { run: publicRun(blocked), record: blocked };
  }
  try {
    if (input.signal?.aborted) throw new GitAutomationError('cancelled');
    const view = await input.git.load();
    if (view.status.state !== 'ready' || view.status.branch !== record.branch || view.status.head !== record.commit || view.status.entries.some((entry) => entry.kind === 'unmerged'))
      throw new GitAutomationError('commit-or-branch-conflict');
    await input.publisher.check(record.destinationUrl, record.branch, record.commit);
    if (input.signal?.aborted) throw new GitAutomationError('cancelled');
    await input.publisher.publish(record.destinationUrl, record.branch, record.commit, input.signal);
    const pushed: PersistedRun = { ...record, state: 'pushed', code: undefined, updatedAt: timestamp };
    return { run: publicRun(pushed), record: pushed };
  } catch (error) {
    const blocked: PersistedRun = { ...record, state: 'blocked', code: automationFailureCode(error), updatedAt: timestamp };
    return { run: publicRun(blocked), record: blocked };
  }
}

/** A retry can only send the exact commit already recorded; it never re-stages or recreates it. */
export async function resumeGitAutomationPush(input: { policy: GitAutomationPolicy; record?: PersistedRun; git: GitAutomationPort; publisher?: GitAutomationPublisher;
  pushAvailable: boolean; capabilities: { push: boolean }; now?: number; signal?: AbortSignal }): Promise<{ run: GitAutomationRun; record: PersistedRun }> {
  const timestamp = input.now ?? now(), policy = validateGitAutomationPolicy(input.policy), record = input.record;
  if (!record?.commit || !record.destinationUrl || !(record.state === 'push-pending' || record.state === 'blocked' && ['authorization-expired', 'cancelled', 'remote-conflict', 'remote-permission-denied'].includes(record.code ?? ''))) throw new GitAutomationError('no-pending-push');
  if (record.policyHash !== sha256(JSON.stringify(policy)) || !policy.pushAfterCommit) throw new GitAutomationError('automation-policy-changed');
  if (!input.pushAvailable) throw new GitAutomationError('mounted-push-unavailable');
  if (!input.capabilities.push) throw new GitAutomationError('push-permission-denied');
  if (!input.publisher) throw new GitAutomationError('authorization-unavailable');
  const result = await finishOrPush({ bindingHash: '', policy, stored: record, git: input.git, publisher: input.publisher, pushAvailable: input.pushAvailable,
    capabilities: { stage: false, commit: false, push: input.capabilities.push }, now: timestamp, signal: input.signal }, policy, { ...record, state: 'push-pending', code: undefined }, timestamp);
  return result;
}

export type { PersistedRun as StoredGitAutomationRun };

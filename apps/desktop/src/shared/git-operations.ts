import type { GitRepositoryStatus } from './git-status';
import type { LocalMountCapabilities } from '@a3/project-store';
import type { GitAutomationRequest, GitAutomationValue } from './git-automation';
export type { GitAutomationMode, GitAutomationPolicy, GitAutomationRun, GitAutomationSnapshot } from './git-automation';
export type { GitAutomationRequest } from './git-automation';
export const GIT_OPERATIONS_CHANNEL = 'a3.git:local';
export type GitAction = 'stage' | 'unstage' | 'commit' | 'restore' | 'restore-commit' | 'branch' | 'undo-restore';
export interface GitReviewInput {
  kind: GitAction;
  paths?: readonly string[];
  commit?: string;
  message?: string;
  name?: string;
  email?: string;
  branch?: string;
  undoToken?: string;
}
export interface GitDiffView { path: string; text: string; binary: boolean; hunks: readonly { id: string; text: string }[]; }
export interface GitReviewView {
  token: string; root: string; kind: GitAction; branch: string | null; paths: readonly string[]; diffs: readonly GitDiffView[];
  message?: string; targetBranch?: string; targetCommit?: string; warnings: readonly string[];
}
export interface GitProjectView { root: string; status: GitRepositoryStatus; branches: readonly { name: string; oid: string }[]; log: readonly { oid: string; subject: string; date: string }[]; }
export interface GitMountChoice { mountId: string; label: string; root: string | null; status: 'available' | 'root-missing' | 'root-changed' | 'unbound'; capabilities: LocalMountCapabilities; relativePaths: readonly string[]; }
export interface GitApplied { applied: true; kind: GitAction; snapshotId?: string; undoToken?: string; commit?: string; }
export type GitRequest = GitAutomationRequest |
  { action: 'mounts'; sessionId: string }
  | { action: 'mount-capability'; sessionId: string; mountId: string; granted: boolean }
  | { action: 'load'; sessionId: string; mountId?: string }
  | { action: 'review'; sessionId: string; input: GitReviewInput; mountId?: string }
  | { action: 'apply'; sessionId: string; token: string; hunkIds?: readonly string[]; mountId?: string }
  | { action: 'cancel'; sessionId: string; token: string; mountId?: string };
export type GitResult = { ok: true; value: GitProjectView | GitReviewView | GitApplied | GitAutomationValue | readonly GitMountChoice[] | { changed: true } | { cancelled: true } } | { ok: false; error: { code: string; message: string } };
export function validGitRequest(value: unknown): value is GitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, uuid = (id: unknown): boolean => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  if (!uuid(v.sessionId)) return false;
  if (['automation-state', 'automation-preview', 'automation-resume'].includes(String(v.action))) return Object.keys(v).every((key) => ['action', 'sessionId', 'mountId'].includes(key)) && (v.mountId === undefined || uuid(v.mountId));
  if (v.action === 'automation-save') {
    if (!Object.keys(v).every((key) => ['action', 'sessionId', 'mountId', 'policy'].includes(key)) || v.mountId !== undefined && !uuid(v.mountId) || !v.policy || typeof v.policy !== 'object' || Array.isArray(v.policy)) return false;
    const p = v.policy as Record<string, unknown>;
    return Object.keys(p).every((key) => ['schemaVersion', 'mode', 'idleMs', 'branch', 'paths', 'messageTemplate', 'authorName', 'authorEmail', 'pushAfterCommit', 'destinationUrl'].includes(key)) &&
      p.schemaVersion === '1.0.0' && ['manual', 'auto-after-idle'].includes(String(p.mode)) && Number.isSafeInteger(p.idleMs) && typeof p.branch === 'string' &&
      Array.isArray(p.paths) && p.paths.length <= 128 && p.paths.every((path) => typeof path === 'string' && path.length <= 1024) &&
      typeof p.messageTemplate === 'string' && p.messageTemplate.length <= 512 && typeof p.authorName === 'string' && p.authorName.length <= 256 &&
      typeof p.authorEmail === 'string' && p.authorEmail.length <= 320 && typeof p.pushAfterCommit === 'boolean' &&
      (p.destinationUrl === undefined || typeof p.destinationUrl === 'string' && p.destinationUrl.length <= 200);
  }
  if (v.action === 'mounts') return Object.keys(v).length === 2;
  if (v.action === 'mount-capability') return Object.keys(v).length === 4 && Object.keys(v).every((key) => ['action', 'sessionId', 'mountId', 'granted'].includes(key)) && uuid(v.mountId) && typeof v.granted === 'boolean';
  if (v.mountId !== undefined && !uuid(v.mountId)) return false;
  if (v.action === 'load') return Object.keys(v).every((key) => ['action', 'sessionId', 'mountId'].includes(key));
  if (v.action === 'apply' || v.action === 'cancel') return uuid(v.token) && Object.keys(v).every((key) => ['action', 'sessionId', 'token', 'mountId', ...(v.action === 'apply' ? ['hunkIds'] : [])].includes(key)) &&
    (v.hunkIds === undefined || Array.isArray(v.hunkIds) && v.hunkIds.length <= 256 && v.hunkIds.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)));
  if (v.action !== 'review' || ![3, 4].includes(Object.keys(v).length) || Object.keys(v).some((key) => !['action', 'sessionId', 'input', 'mountId'].includes(key)) || !v.input || typeof v.input !== 'object' || Array.isArray(v.input)) return false;
  const i = v.input as Record<string, unknown>;
  return ['stage', 'unstage', 'commit', 'restore', 'restore-commit', 'branch', 'undo-restore'].includes(String(i.kind)) &&
    Object.keys(i).every((key) => ['kind', 'paths', 'commit', 'message', 'name', 'email', 'branch', 'undoToken'].includes(key)) &&
    (i.kind !== 'restore-commit' || typeof i.commit === 'string' && /^[a-f0-9]{40}$/.test(i.commit) && !('paths' in i)) &&
    Object.entries(i).every(([key, field]) => key === 'paths' ? Array.isArray(field) && field.length <= 128 && field.every((path) => typeof path === 'string' && path.length <= 1024) : typeof field === 'string' && field.length <= (key === 'message' ? 4096 : 1024));
}

import type { GitRepositoryStatus } from './git-status';
export const GIT_OPERATIONS_CHANNEL = 'a3.git:local';
export type GitAction = 'stage' | 'unstage' | 'commit' | 'restore' | 'branch' | 'undo-restore';
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
export type GitRequest = { action: 'load'; sessionId: string } |
  { action: 'review'; sessionId: string; input: GitReviewInput } |
  { action: 'apply'; sessionId: string; token: string; hunkIds?: readonly string[] } |
  { action: 'cancel'; sessionId: string; token: string };
export interface GitDiffView { path: string; text: string; binary: boolean; hunks: readonly { id: string; text: string }[]; }
export interface GitReviewView {
  token: string; root: string; kind: GitAction; branch: string | null; paths: readonly string[]; diffs: readonly GitDiffView[];
  message?: string; targetBranch?: string; targetCommit?: string; warnings: readonly string[];
}
export interface GitProjectView { root: string; status: GitRepositoryStatus; branches: readonly { name: string; oid: string }[]; log: readonly { oid: string; subject: string }[]; }
export interface GitApplied { applied: true; kind: GitAction; snapshotId?: string; undoToken?: string; commit?: string; }
export type GitResult = { ok: true; value: GitProjectView | GitReviewView | GitApplied | { cancelled: true } } | { ok: false; error: { code: string; message: string } };
export function validGitRequest(value: unknown): value is GitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, uuid = (id: unknown): boolean => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
  if (!uuid(v.sessionId)) return false;
  if (v.action === 'load') return Object.keys(v).length === 2;
  if (v.action === 'apply' || v.action === 'cancel') return uuid(v.token) && Object.keys(v).every((key) => ['action', 'sessionId', 'token', ...(v.action === 'apply' ? ['hunkIds'] : [])].includes(key)) &&
    (v.hunkIds === undefined || Array.isArray(v.hunkIds) && v.hunkIds.length <= 256 && v.hunkIds.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)));
  if (v.action !== 'review' || Object.keys(v).length !== 3 || !v.input || typeof v.input !== 'object' || Array.isArray(v.input)) return false;
  const i = v.input as Record<string, unknown>;
  return ['stage', 'unstage', 'commit', 'restore', 'branch', 'undo-restore'].includes(String(i.kind)) &&
    Object.keys(i).every((key) => ['kind', 'paths', 'commit', 'message', 'name', 'email', 'branch', 'undoToken'].includes(key)) &&
    Object.entries(i).every(([key, field]) => key === 'paths' ? Array.isArray(field) && field.length <= 128 && field.every((path) => typeof path === 'string' && path.length <= 1024) : typeof field === 'string' && field.length <= (key === 'message' ? 4096 : 1024));
}

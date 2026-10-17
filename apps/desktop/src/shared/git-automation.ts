import type { GitDiffView } from './git-operations.ts';

export type GitAutomationMode = 'manual' | 'auto-after-idle';
export interface GitAutomationPolicy {
  schemaVersion: '1.0.0';
  mode: GitAutomationMode;
  idleMs: number;
  branch: string;
  paths: readonly string[];
  messageTemplate: string;
  authorName: string;
  authorEmail: string;
  pushAfterCommit: boolean;
  destinationUrl?: string;
}
export interface GitAutomationRun {
  state: 'idle' | 'waiting' | 'committing' | 'push-pending' | 'committed' | 'pushed' | 'blocked';
  code?: string;
  branch?: string;
  files: readonly string[];
  commit?: string;
  updatedAt: number;
  stableSince?: number;
  diffs?: readonly GitDiffView[];
}
export interface GitAutomationSnapshot {
  repositoryLabel: string;
  policy: GitAutomationPolicy;
  run: GitAutomationRun;
  capabilities: { stage: boolean; commit: boolean; push: boolean; pushCredentialAvailable: boolean };
}

export type GitAutomationRequest =
  | { action: 'automation-state'; sessionId: string; mountId?: string }
  | { action: 'automation-save'; sessionId: string; mountId?: string; policy: GitAutomationPolicy }
  | { action: 'automation-preview'; sessionId: string; mountId?: string }
  | { action: 'automation-resume'; sessionId: string; mountId?: string };

export type GitAutomationValue = GitAutomationSnapshot | { saved: true } | { preview: true; branch: string | null; files: readonly string[]; diffs: readonly GitDiffView[] };

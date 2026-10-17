/** Display DTOs only. Roots, executable paths and process arguments stay in the host. */
export type GitRepositoryKind = 'a3-project' | 'referenced';
export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  kind: 'tracked' | 'untracked' | 'unmerged';
}
export interface GitRepositoryStatus {
  repositoryId: string;
  kind: GitRepositoryKind;
  state: 'ready' | 'not-installed' | 'unverified-binary' | 'not-repository' | 'unsupported-repository' |
    'root-unavailable' | 'root-changed' | 'permission-denied' | 'cancelled' | 'timeout' | 'output-limit' | 'invalid-output' | 'failed';
  version?: string;
  branch?: string | null;
  head?: string | null;
  unborn?: boolean;
  entries: readonly GitStatusEntry[];
  excludedTrackedCount: number;
  diagnostics: readonly string[];
}

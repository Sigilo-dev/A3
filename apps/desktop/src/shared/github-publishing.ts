export const GITHUB_CHANNEL = 'a3.github:publishing';
export interface GithubAccount { id: number; login: string; }
export interface GithubReview {
  token: string; kind: 'push' | 'create'; root: string; account: GithubAccount; url: string;
  visibility: 'private' | 'public'; branch: string; commit: string; files: readonly { path: string; bytes: number }[];
  exclusions: readonly string[]; historyObjects: number; bytes: number; remoteId?: number;
}
export type GithubRequest = { action: 'status' | 'connect-manual' | 'disconnect' | 'manual-help'; sessionId: string } |
  { action: 'review'; sessionId: string; kind: 'push' | 'create'; url: string; branch: string; visibility: 'private' | 'public' } |
  { action: 'apply'; sessionId: string; token: string; confirmedUrl: string } |
  { action: 'cancel'; sessionId: string; token: string };
export type GithubValue = { state: 'manual' | 'connected'; account?: GithubAccount; protectedStorage: boolean } | GithubReview |
  { completed: 'created' | 'pushed' | 'cancelled' | 'disconnected' | 'help'; url?: string; commit?: string };
export type GithubResult = { ok: true; value: GithubValue } | { ok: false; error: { code: string; message: string } };
export function validGithubRequest(input: unknown): input is GithubRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const v = input as Record<string, unknown>, uuid = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  if (!uuid(v.sessionId)) return false;
  const keys = ['action', 'sessionId'];
  if (['status', 'connect-manual', 'disconnect', 'manual-help'].includes(String(v.action))) return Object.keys(v).length === 2;
  if (v.action === 'cancel' || v.action === 'apply') return uuid(v.token) && (v.action === 'cancel' || typeof v.confirmedUrl === 'string' && v.confirmedUrl.length <= 200) && Object.keys(v).every((key) => [...keys, 'token', ...(v.action === 'apply' ? ['confirmedUrl'] : [])].includes(key));
  return v.action === 'review' && ['push', 'create'].includes(String(v.kind)) && ['private', 'public'].includes(String(v.visibility)) && typeof v.url === 'string' && v.url.length <= 200 && typeof v.branch === 'string' && v.branch.length <= 120 && Object.keys(v).length === 6;
}

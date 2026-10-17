import type { LocalHistoryRestorePreview, SnapshotSummary } from '@a3/project-store';
import type { WriteReceipt } from '@a3/project-store';

export const HISTORY_CHANNEL = 'a3.history:project';
export type HistoryRequest = { action: 'load'; sessionId: string } |
  { action: 'preview'; sessionId: string; snapshotId: string } |
  { action: 'apply' | 'cancel'; sessionId: string; token: string };
export type HistoryValue = { snapshots: readonly SnapshotSummary[]; diagnostics: readonly string[] } | LocalHistoryRestorePreview | WriteReceipt | { cancelled: true };
export type HistoryResult = { ok: true; value: HistoryValue } | { ok: false; error: { code: string; message: string; recovery: string } };

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function validHistoryRequest(value: unknown): value is HistoryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (!uuid(request.sessionId)) return false;
  if (request.action === 'load') return Object.keys(request).length === 2;
  if (request.action === 'preview') return Object.keys(request).length === 3 && uuid(request.snapshotId);
  return (request.action === 'apply' || request.action === 'cancel') && Object.keys(request).length === 3 && uuid(request.token);
}

import { TASK_STATES, validEvidenceTarget } from '@a3/domain/planning';
import type { ProjectPlanningState, PlanningTaskUpdate, PlanningEvidenceInput, PlanningProposalPreview } from '@a3/project-store';
export const PLANNING_CHANNEL = 'a3.planning:command';
export type PlanningRequest = { action: 'load'; sessionId: string } |
  { action: 'update-task'; sessionId: string; input: PlanningTaskUpdate } |
  { action: 'add-evidence'; sessionId: string; input: PlanningEvidenceInput } |
  { action: 'create-task'; sessionId: string; title: string; storyId?: string } |
  { action: 'create-story'; sessionId: string; input: { title: string; actor: string; need: string; goal: string; criteria: string[] } } |
  { action: 'set-policy'; sessionId: string; expectedRevision: number; requireEvidenceForDone: boolean } |
  { action: 'preview-proposal'; sessionId: string; source: string } |
  { action: 'apply-proposal'; sessionId: string; token: string; selectedKeys: string[] } |
  { action: 'show-task'; sessionId: string; entityId: string; workspaceId: string };
export type PlanningValue = ProjectPlanningState | PlanningProposalPreview | { workspaceId: string; placementId: string };
export type PlanningResult = { ok: true; value: PlanningValue } | { ok: false; error: { code: string; message: string; recovery: string } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1024 && v.every(uuid) && new Set(v.map((id) => id.toLowerCase())).size === v.length;
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
function keys(value: Record<string, unknown>, allowed: string[], required = allowed): boolean { return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key)); }
export function validPlanningRequest(value: unknown): value is PlanningRequest {
  if (!object(value) || !uuid(value.sessionId)) return false;
  try { if (JSON.stringify(value).length > 300 * 1024) return false; } catch { return false; }
  switch (value.action) {
    case 'load': return keys(value, ['action', 'sessionId']);
    case 'update-task': return keys(value, ['action', 'sessionId', 'input']) && object(value.input) && keys(value.input, ['entityId', 'expectedRevision', 'state', 'evidenceIds']) && uuid(value.input.entityId) && revision(value.input.expectedRevision) && TASK_STATES.includes(value.input.state as typeof TASK_STATES[number]) && ids(value.input.evidenceIds);
    case 'add-evidence': return keys(value, ['action', 'sessionId', 'input']) && object(value.input) && keys(value.input, ['taskId', 'expectedRevision', 'title', 'target', 'criterionIds']) && uuid(value.input.taskId) && revision(value.input.expectedRevision) && text(value.input.title) && validEvidenceTarget(value.input.target) && ids(value.input.criterionIds);
    case 'create-task': return keys(value, ['action', 'sessionId', 'title', 'storyId'], ['action', 'sessionId', 'title']) && text(value.title) && (value.storyId === undefined || uuid(value.storyId));
    case 'create-story': return keys(value, ['action', 'sessionId', 'input']) && object(value.input) && keys(value.input, ['title', 'actor', 'need', 'goal', 'criteria']) && text(value.input.title) && text(value.input.actor, 1000) && text(value.input.need, 20000) && text(value.input.goal, 20000) && Array.isArray(value.input.criteria) && value.input.criteria.length <= 127 && value.input.criteria.every((v) => text(v));
    case 'set-policy': return keys(value, ['action', 'sessionId', 'expectedRevision', 'requireEvidenceForDone']) && revision(value.expectedRevision) && typeof value.requireEvidenceForDone === 'boolean';
    case 'preview-proposal': return keys(value, ['action', 'sessionId', 'source']) && typeof value.source === 'string' && value.source.length <= 256 * 1024;
    case 'apply-proposal': return keys(value, ['action', 'sessionId', 'token', 'selectedKeys']) && uuid(value.token) && Array.isArray(value.selectedKeys) && value.selectedKeys.length > 0 && value.selectedKeys.length <= 128 && value.selectedKeys.every((key) => typeof key === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(key)) && new Set(value.selectedKeys).size === value.selectedKeys.length;
    case 'show-task': return keys(value, ['action', 'sessionId', 'entityId', 'workspaceId']) && uuid(value.entityId) && uuid(value.workspaceId);
    default: return false;
  }
}

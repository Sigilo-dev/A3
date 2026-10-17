import type { ProjectMemoryState, ProjectSearchState } from '@a3/project-store';
export const MEMORY_SEARCH_CHANNEL = 'a3.memory-search:command';
export type MemorySearchRequest = { action: 'memory'; sessionId: string } | { action: 'initialize'; sessionId: string } |
  { action: 'search'; sessionId: string; query: string; rebuild: boolean; exclusions?: string[] } |
  { action: 'summary'; sessionId: string; input: { title: string; content: string; sourceIds: string[] } };
export type MemorySearchResult = { ok: true; value: ProjectMemoryState | ProjectSearchState } | { ok: false; error: { code: string; message: string; recovery: string } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const keys = (value: Record<string, unknown>, allowed: string[], required = allowed) => Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
export function validMemorySearchRequest(value: unknown): value is MemorySearchRequest {
  if (!object(value) || !uuid(value.sessionId)) return false;
  try { if (JSON.stringify(value).length > 3 * 1024 * 1024) return false; } catch { return false; }
  if (value.action === 'memory' || value.action === 'initialize') return keys(value, ['action', 'sessionId']);
  if (value.action === 'search') return keys(value, ['action', 'sessionId', 'query', 'rebuild', 'exclusions'], ['action', 'sessionId', 'query', 'rebuild']) && typeof value.query === 'string' && value.query.length <= 500 && typeof value.rebuild === 'boolean' &&
    (value.exclusions === undefined || Array.isArray(value.exclusions) && value.exclusions.length <= 64 && value.exclusions.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 160 && /^[\w./*? -]+$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/')));
  return value.action === 'summary' && keys(value, ['action', 'sessionId', 'input']) && object(value.input) && keys(value.input, ['title', 'content', 'sourceIds']) && typeof value.input.title === 'string' && !!value.input.title.trim() && value.input.title.length <= 200 && typeof value.input.content === 'string' && !!value.input.content.trim() && value.input.content.length <= 2 * 1024 * 1024 && Array.isArray(value.input.sourceIds) && value.input.sourceIds.length > 0 && value.input.sourceIds.length <= 64 && value.input.sourceIds.every(uuid) && new Set(value.input.sourceIds).size === value.input.sourceIds.length;
}

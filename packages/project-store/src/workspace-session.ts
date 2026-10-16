import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sha256 } from './codec.js';
import { jsonBytes } from './progress.js';

export interface PageViewState {
  mode: 'visual' | 'source' | 'preview'; scrollTop: number; scrollLeft: number;
  selection: { anchor: number; head: number } | null;
}
export interface CanvasViewState { x: number; y: number; zoom: number; }
export type FocusTab =
  | { id: string; kind: 'page'; entityId: string; resourceId: string; title: string; view: PageViewState }
  | { id: string; kind: 'workspace'; workspaceId: string; title: string; view: CanvasViewState | null };
export interface WorkspaceSession {
  schemaVersion: '1.0.0'; projectId: string; rootIdentity: string; revision: number; tabs: FocusTab[]; selectedId: string | null;
}
export type WorkspaceSessionAction =
  | { action: 'load' }
  | { action: 'open-page'; entityId: string; anotherView?: boolean }
  | { action: 'open-workspace'; workspaceId: string }
  | { action: 'activate' | 'close'; tabId: string }
  | { action: 'reorder'; tabIds: string[] }
  | { action: 'view'; tabId: string; view: PageViewState | CanvasViewState };
export interface PageReference {
  entityId: string; resourceId: string; title: string; relativePath: string | null;
  kind: 'project-file' | 'mounted-file' | 'remote-url' | 'missing'; mountId?: string;
}
export const initialPageView = (): PageViewState => ({ mode: 'visual', scrollTop: 0, scrollLeft: 0, selection: null });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const offset = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12;
export function validPageView(value: unknown): value is PageViewState {
  if (!record(value) || !exact(value, ['mode', 'scrollTop', 'scrollLeft', 'selection']) || !['visual', 'source', 'preview'].includes(String(value.mode)) || !offset(value.scrollTop) || !offset(value.scrollLeft)) return false;
  const selection = value.selection;
  return selection === null || record(selection) && exact(selection, ['anchor', 'head']) && Number.isSafeInteger(selection.anchor) && Number.isSafeInteger(selection.head) && offset(selection.anchor) && offset(selection.head);
}
export function validCanvasView(value: unknown): value is CanvasViewState {
  return record(value) && exact(value, ['x', 'y', 'zoom']) && typeof value.x === 'number' && Number.isFinite(value.x) && Math.abs(value.x) <= 1e15 &&
    typeof value.y === 'number' && Number.isFinite(value.y) && Math.abs(value.y) <= 1e15 && typeof value.zoom === 'number' && value.zoom > 0 && value.zoom <= 8;
}
export function validWorkspaceSession(value: unknown): value is WorkspaceSession {
  if (!record(value) || !exact(value, ['schemaVersion', 'projectId', 'rootIdentity', 'revision', 'tabs', 'selectedId']) || value.schemaVersion !== '1.0.0' || !id(value.projectId) ||
      typeof value.rootIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.rootIdentity) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.tabs) || value.tabs.length > 100) return false;
  const ids = new Set<string>();
  for (const tab of value.tabs) {
    if (!record(tab) || !id(tab.id) || ids.has(tab.id) || typeof tab.title !== 'string' || tab.title.length > 512) return false;
    ids.add(tab.id);
    if (tab.kind === 'page') { if (!exact(tab, ['id', 'kind', 'entityId', 'resourceId', 'title', 'view']) || !id(tab.entityId) || !id(tab.resourceId) || !validPageView(tab.view)) return false; }
    else if (tab.kind === 'workspace') { if (!exact(tab, ['id', 'kind', 'workspaceId', 'title', 'view']) || !id(tab.workspaceId) || tab.view !== null && !validCanvasView(tab.view)) return false; }
    else return false;
  }
  return value.tabs.length === 0 ? value.selectedId === null : typeof value.selectedId === 'string' && ids.has(value.selectedId);
}
export function insertFocusTab(state: WorkspaceSession, tab: FocusTab, anotherView = false): void {
  const existing = !anotherView && state.tabs.find((item) => item.kind === tab.kind && (item.kind === 'page' && tab.kind === 'page' ? item.entityId === tab.entityId : item.kind === 'workspace' && tab.kind === 'workspace' && item.workspaceId === tab.workspaceId));
  if (existing) { state.selectedId = existing.id; return; }
  if (state.tabs.length >= 100) throw new Error('Cierra alguna pestaña antes de abrir otra (límite local: 100).');
  const index = state.tabs.findIndex((item) => item.id === state.selectedId);
  state.tabs.splice(index + 1, 0, tab); state.selectedId = tab.id;
}
async function sessionPath(directory: string, projectId: string, rootIdentity: string): Promise<string> {
  const folder = join(directory, 'workspace-sessions');
  await mkdir(folder, { recursive: true });
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(folder)).toLowerCase() !== folder.toLowerCase()) throw new Error('El directorio de sesiones locales cambió.');
  return join(folder, sha256(Buffer.from(`${rootIdentity}:${projectId}`)) + '.json');
}
export async function readWorkspaceSession(directory: string, projectId: string, rootIdentity: string): Promise<WorkspaceSession | null> {
  const path = await sessionPath(directory, projectId, rootIdentity);
  let handle;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('La sesión local no es un archivo válido.');
    handle = await open(path, 'r');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (!validWorkspaceSession(value) || value.projectId !== projectId || value.rootIdentity !== rootIdentity) throw new Error('La sesión local tiene una versión, identidad o estructura desconocida; se conserva sin sobrescribirla.');
    return value;
  } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
export async function writeWorkspaceSession(directory: string, value: WorkspaceSession): Promise<void> {
  if (!validWorkspaceSession(value)) throw new Error('Estado de pestañas no válido.');
  const bytes = jsonBytes(value); if (bytes.length > 256 * 1024) throw new Error('La sesión supera el límite local.');
  const path = await sessionPath(directory, value.projectId, value.rootIdentity);
  await readWorkspaceSession(directory, value.projectId, value.rootIdentity);
  const temp = path + '.' + randomUUID() + '.tmp', handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => undefined); }
}

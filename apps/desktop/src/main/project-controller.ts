import { clipboard, dialog, type BrowserWindow } from 'electron';
import { validC4Operation, validUmlOperation } from '@a3/domain';
import { validErOperation } from '@a3/domain/er';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import { CONTENT_NODE_CATALOG, CONCEPTUAL_NODE_CATALOG, CONCEPTUAL_RELATION_KINDS, IOT_CATALOG, resolveSmartPastePayload } from '@a3/domain';
import { validIotCircuitOperation } from '@a3/domain/iot-circuit';
import { createProjectCapabilityBroker, LocalProjectManager, LocalProjectError } from '@a3/project-store';
import type { CanvasContentRequest, CanvasContentResult, CanvasMermaidImportResult, CanvasPlantUmlResult, CanvasRequest, CanvasResult, CodeRequest, CodeResult, FileDropStageResult, FilesRequest, FilesResult, MarkdownRequest, MarkdownResult, ProjectsRequest, ProjectsResult } from '../shared/desktop-api';
import { validViewport } from '../shared/world-viewport';
import { validCanvasView, validPageView } from '@a3/project-store';
import type { WorkspaceSessionRequest, WorkspaceSessionResult } from '../shared/desktop-api';
import type { NavigationRequest, NavigationResult } from '../shared/desktop-api';
import { validateShortcuts } from '@a3/domain';
import { PLANTUML_ARTIFACT_FILE, PlantUmlRenderer } from './plantuml-renderer';

function validNavigationRequest(value: unknown): value is NavigationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, id = (s: unknown): boolean => typeof s === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
  const keys = (names: string[]): boolean => Object.keys(v).length === names.length + 1 && names.every((n) => n in v);
  if (v.action === 'shortcuts-load' || v.action === 'shortcuts-reset') return keys([]);
  if (v.action === 'shortcuts-save') return keys(['bindings']) && validateShortcuts(v.bindings).ok;
  if (!id(v.sessionId)) return false;
  if (v.action === 'index' || v.action === 'permissions') return keys(['sessionId']);
  if (v.action === 'resolve') return keys(['sessionId', 'sourceId', 'target', 'kind']) && id(v.sourceId) && typeof v.target === 'string' && v.target.length <= 2048 && ['wiki', 'markdown'].includes(String(v.kind));
  if (!id(v.entityId)) return false;
  if (v.action === 'copy-link') return keys(['sessionId', 'entityId']);
  if (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1) return false;
  return v.action === 'rename-page' && keys(['sessionId', 'entityId', 'expectedRevision', 'title']) && typeof v.title === 'string' && v.title.length <= 200 ||
    v.action === 'move-page' && keys(['sessionId', 'entityId', 'expectedRevision', 'destination']) && typeof v.destination === 'string' && v.destination.length <= 1024;
}

function validSessionRequest(value: unknown): value is WorkspaceSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = (n: unknown): boolean => typeof n === 'string' && uuid.test(n);
  if (!id(v.sessionId)) return false;
  const shapes: Record<string, string[]> = { load: [], reference: ['tabId'], locate: ['tabId'], 'open-page': ['entityId'], 'open-workspace': ['workspaceId'], activate: ['tabId'], close: ['tabId'], reorder: ['tabIds'], view: ['tabId', 'view'] };
  const keys = typeof v.action === 'string' && Object.hasOwn(shapes, v.action) ? shapes[v.action] : undefined;
  if (!keys) return false;
  const mutation = !['load', 'reference', 'locate'].includes(String(v.action)), allowed = ['action', 'sessionId', ...keys, ...(mutation ? ['expectedRevision'] : []), ...(v.action === 'open-page' ? ['anotherView'] : [])];
  if (Object.keys(v).some((k) => !allowed.includes(k)) || keys.some((k) => !Object.hasOwn(v, k)) || mutation && (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 0)) return false;
  if (v.action === 'view' && !validCanvasView(v.view) && !validPageView(v.view)) return false;
  if (v.action === 'reorder' && (!Array.isArray(v.tabIds) || v.tabIds.length > 100 || !v.tabIds.every(id))) return false;
  if ('anotherView' in v && typeof v.anotherView !== 'boolean') return false;
  return keys.filter((k) => k.endsWith('Id')).every((k) => id(v[k]));
}

interface StagedDropFile { path: string; root: string; relativePath: string; mountId: string; resourceId: string; name: string; size: number; mediaType: string; }
interface StagedDrop { files: StagedDropFile[]; kind: 'file' | 'folder'; createdAt: number; }
const dropExtensionType: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', pdf: 'application/pdf' };
function normalizeNativePath(path: string): string { return resolve(path).replace(/[\\/]+$/, '').toLowerCase(); }
async function inspectDropPath(input: string): Promise<{ path: string; kind: 'file' | 'folder'; size: number; identity: string }> {
  if (typeof input !== 'string' || !input || input.length > 32767) throw new Error('La ruta del archivo arrastrado no es válida.');
  const absolute = resolve(input), root = parse(absolute).root;
  if (!root || absolute === root || !/^[a-z]:[\\/]/i.test(root)) throw new Error('Arrastra un archivo o carpeta de una unidad local, no una unidad o ruta de red.');
  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('A3 no sigue symlinks ni junctions durante un drop.');
    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) throw new Error('La ruta externa contiene un segmento que no es una carpeta.');
    if (isLast && !stat.isFile() && !stat.isDirectory()) throw new Error('Solo se admiten archivos regulares o carpetas.');
    const physical = await realpath(current);
    if (normalizeNativePath(physical) !== normalizeNativePath(current)) throw new Error('A3 no sigue junctions ni rutas redirigidas durante un drop.');
    if (isLast) return { path: absolute, kind: stat.isDirectory() ? 'folder' : 'file', size: stat.isFile() ? Number(stat.size) : 0,
      identity: `${stat.dev.toString(16)}:${stat.ino.toString(16)}:${(stat.mode & 0o170000n).toString(16)}` };
  }
  throw new Error('La ruta externa no es válida.');
}

function validCanvasRequest(value: unknown): value is CanvasRequest | CanvasContentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof input.action !== 'string' || typeof input.sessionId !== 'string' || typeof input.workspaceId !== 'string' || !uuid.test(input.sessionId) || !uuid.test(input.workspaceId)) return false;
  if (input.action === 'plantuml-render') return Object.keys(input).length === 4 && uuid.test(String(input.sourceEntityId));
  if (input.action === 'mermaid-import-preview') return Object.keys(input).length === 4 && uuid.test(String(input.sourceEntityId));
  if (input.action === 'mermaid-import-apply') return Object.keys(input).length === 5 && uuid.test(String(input.token)) && ['source', 'a3-model'].includes(String(input.authority));
  if (input.action === 'uml') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 && validUmlOperation(input.operation);
  if (input.action === 'er') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 && validErOperation(input.operation);
  if (input.action === 'create-iot-component') return Object.keys(input).length === 7 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    typeof input.catalogId === 'string' && IOT_CATALOG.some((entry) => entry.catalogId === input.catalogId && !entry.template) &&
    typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 200 && validPoint(input.position);
  if (input.action === 'create-iot-circuit') return Object.keys(input).length === 6 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 200 && validPoint(input.position);
  if (input.action === 'change-iot-circuit') return Object.keys(input).length === 6 && uuid.test(String(input.entityId)) &&
    Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 && validIotCircuitOperation({ kind: 'replace-model', model: input.model });
  if (input.action === 'c4') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 && validC4Operation(input.operation);
  if (input.action === 'stage') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 && validViewport(input.viewport);
  if (input.action === 'create-placement') return Object.keys(input).length === 6 && uuid.test(String(input.entityId)) && Number.isSafeInteger(input.expectedWorkspaceRevision) &&
    Number(input.expectedWorkspaceRevision) >= 1 && !!input.position && typeof input.position === 'object' && !Array.isArray(input.position) &&
    Object.keys(input.position).length === 2 && Number.isFinite((input.position as Record<string, unknown>).x) && Number.isFinite((input.position as Record<string, unknown>).y);
  if (input.action === 'smart-paste') return Object.keys(input).length === 6 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    ['smart', 'text'].includes(String(input.mode)) && validPoint(input.position);
  if (input.action === 'drop-file') return Object.keys(input).length === 7 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    uuid.test(String(input.token)) && ['copy', 'reference', 'move'].includes(String(input.mode)) && validPoint(input.position);
  if (input.action === 'cancel-drop') return Object.keys(input).length === 4 && uuid.test(String(input.token));
  if (input.action === 'create-content-node') {
    const node = input.node as Record<string, unknown> | null;
    if (Object.keys(input).length !== 5 || !Number.isSafeInteger(input.expectedWorkspaceRevision) || Number(input.expectedWorkspaceRevision) < 1 ||
        !node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).some((key) => !['kind', 'title', 'position', 'value', 'url', 'resourceId', 'description', 'altText', 'language'].includes(key)) ||
        !CONTENT_NODE_CATALOG.some((item) => item.kind === node.kind) || typeof node.title !== 'string' || !node.title.trim() || node.title.length > 200 || !validPoint(node.position)) return false;
    const definition = CONTENT_NODE_CATALOG.find((item) => item.kind === node.kind)!;
    if (definition.source === 'inline') {
      if (node.kind === 'mermaid' && typeof node.resourceId === 'string') return uuid.test(node.resourceId) && !('value' in node) && !('url' in node);
      return typeof node.value === 'string' && node.value.length <= 1_000_000 && !('url' in node) && !('resourceId' in node);
    }
    if (definition.source === 'url') return typeof node.url === 'string' && node.url.length <= 2048 && !('value' in node) && !('resourceId' in node);
    if (node.kind === 'image' && typeof node.url === 'string') return node.url.length <= 2048 && !('value' in node) && !('resourceId' in node);
    return typeof node.resourceId === 'string' && uuid.test(node.resourceId) && !('value' in node) && !('url' in node);
  }
  if (input.action === 'create-conceptual-node') return Object.keys(input).length === 7 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    CONCEPTUAL_NODE_CATALOG.some((entry) => entry.kind === input.kind) && typeof input.title === 'string' && !!input.title.trim() && input.title.length <= 200 && validPoint(input.position);
  if (input.action === 'update-conceptual-node') {
    if (Object.keys(input).length !== 6 || !uuid.test(String(input.entityId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 ||
        !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) return false;
    const patch = input.patch as Record<string, unknown>;
    return Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['title', 'kind'].includes(key)) &&
      (!('title' in patch) || typeof patch.title === 'string' && !!patch.title.trim() && patch.title.length <= 200) &&
      (!('kind' in patch) || CONCEPTUAL_NODE_CATALOG.some((entry) => entry.kind === patch.kind));
  }
  if (input.action === 'create-conceptual-relation') return (Object.keys(input).length === 7 || Object.keys(input).length === 8) &&
    Object.keys(input).every((key) => ['action', 'sessionId', 'workspaceId', 'expectedWorkspaceRevision', 'sourcePlacementId', 'targetPlacementId', 'label', 'kind'].includes(key)) &&
    Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 && uuid.test(String(input.sourcePlacementId)) &&
    uuid.test(String(input.targetPlacementId)) && typeof input.label === 'string' && !!input.label.trim() && input.label.length <= 300 &&
    (!('kind' in input) || CONCEPTUAL_RELATION_KINDS.includes(input.kind as typeof CONCEPTUAL_RELATION_KINDS[number]));
  if (input.action === 'update-conceptual-relation') {
    if (Object.keys(input).length !== 6 || !uuid.test(String(input.relationId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 ||
        !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) return false;
    const patch = input.patch as Record<string, unknown>;
    return Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['label', 'kind'].includes(key)) &&
      (!('label' in patch) || typeof patch.label === 'string' && !!patch.label.trim() && patch.label.length <= 300) &&
      (!('kind' in patch) || patch.kind === null || CONCEPTUAL_RELATION_KINDS.includes(patch.kind as typeof CONCEPTUAL_RELATION_KINDS[number]));
  }
  if (input.action === 'delete-conceptual-relation') return Object.keys(input).length === 5 && uuid.test(String(input.relationId)) &&
    Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1;
  if (input.action === 'update-placement') {
    if (Object.keys(input).length !== 6 || !uuid.test(String(input.placementId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 ||
        !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) return false;
    const patch = input.patch as Record<string, unknown>;
    if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['position', 'size', 'style'].includes(key))) return false;
    if ('position' in patch && (!patch.position || typeof patch.position !== 'object' || Array.isArray(patch.position) || Object.keys(patch.position).length !== 2 ||
        !Number.isFinite((patch.position as Record<string, unknown>).x) || !Number.isFinite((patch.position as Record<string, unknown>).y))) return false;
    if ('size' in patch && (!patch.size || typeof patch.size !== 'object' || Array.isArray(patch.size) || Object.keys(patch.size).length !== 2 ||
        !Number.isFinite((patch.size as Record<string, unknown>).width) || !Number.isFinite((patch.size as Record<string, unknown>).height))) return false;
    return true;
  }
  if (input.action === 'content') return (Object.keys(input).length === 5 || Object.keys(input).length === 6) &&
    Object.keys(input).every((key) => ['action', 'sessionId', 'workspaceId', 'entityId', 'resourceId', 'purpose'].includes(key)) &&
    uuid.test(String(input.entityId)) && uuid.test(String(input.resourceId)) && (input.purpose === undefined || ['preview', 'playback'].includes(String(input.purpose)));
  if (input.action === 'move-placements') return Object.keys(input).length === 4 && Array.isArray(input.placements) && input.placements.length > 0 &&
    input.placements.every((item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 3 &&
      uuid.test(String((item as Record<string, unknown>).id)) && Number.isSafeInteger((item as Record<string, unknown>).expectedRevision) &&
      Number((item as Record<string, unknown>).expectedRevision) >= 1 && validPoint((item as Record<string, unknown>).position));
  const validSelectionRefs = (items: unknown): boolean => Array.isArray(items) && items.length <= 512 && items.every((item: unknown) => !!item && typeof item === 'object' &&
    !Array.isArray(item) && Object.keys(item).length === 2 && uuid.test(String((item as Record<string, unknown>).id)) &&
    Number.isSafeInteger((item as Record<string, unknown>).expectedRevision) && Number((item as Record<string, unknown>).expectedRevision) >= 1);
  if (input.action === 'duplicate-selection') return Object.keys(input).length === 6 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    ['content', 'representation'].includes(String(input.mode)) && !!input.selection && typeof input.selection === 'object' && !Array.isArray(input.selection) &&
    Object.keys(input.selection).length === 3 && validSelectionRefs((input.selection as Record<string, unknown>).placements) &&
    validSelectionRefs((input.selection as Record<string, unknown>).drawings) && validSelectionRefs((input.selection as Record<string, unknown>).groups) &&
    ((input.selection as Record<string, unknown>).placements as unknown[]).length + ((input.selection as Record<string, unknown>).drawings as unknown[]).length +
      ((input.selection as Record<string, unknown>).groups as unknown[]).length > 0;
  if (input.action === 'undo' || input.action === 'redo') return Object.keys(input).length === 3;
  if (input.action === 'update-placement-views') return Object.keys(input).length === 4 && Array.isArray(input.placements) && input.placements.length > 0 && input.placements.length <= 512 &&
    input.placements.every((item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item) &&
      ['id', 'expectedRevision', 'position', 'style'].filter((key) => key in (item as Record<string, unknown>)).length === Object.keys(item).length &&
      uuid.test(String((item as Record<string, unknown>).id)) && Number.isSafeInteger((item as Record<string, unknown>).expectedRevision) && Number((item as Record<string, unknown>).expectedRevision) >= 1 &&
      ('position' in item || 'style' in item) && (!('position' in item) || validPoint((item as Record<string, unknown>).position)) &&
      (!('style' in item) || validStyle((item as Record<string, unknown>).style)));
  const validMembers = (members: unknown, allowEmpty = false): boolean => Array.isArray(members) && (allowEmpty || members.length > 0) && members.length <= 512 &&
    members.every((member: unknown) => !!member && typeof member === 'object' && !Array.isArray(member) &&
      ['placement', 'group', 'drawing'].includes(String((member as Record<string, unknown>).kind)) && uuid.test(String((member as Record<string, unknown>).id)));
  if (input.action === 'create-group') return Object.keys(input).length === 6 && Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 &&
    typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 120 && validMembers(input.members);
  if (['set-group-members', 'rename-group', 'move-group', 'set-group-collapsed'].includes(input.action)) {
    if (!uuid.test(String(input.groupId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) return false;
    if (input.action === 'set-group-members') return Object.keys(input).length === 6 && validMembers(input.members, true);
    if (input.action === 'rename-group') return Object.keys(input).length === 6 && typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 120;
    if (input.action === 'move-group') return Object.keys(input).length === 6 && validPoint(input.offset);
    return Object.keys(input).length === 6 && typeof input.collapsed === 'boolean';
  }
  if (input.action === 'create-visual-edge') return Object.keys(input).length === 6 && uuid.test(String(input.sourcePlacementId)) && uuid.test(String(input.targetPlacementId)) &&
    Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1;
  if (input.action === 'delete-visual-edge') return Object.keys(input).length === 5 && uuid.test(String(input.edgeId)) && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1;
  if (input.action === 'update-visual-edge') {
    if (Object.keys(input).length !== 6 || !uuid.test(String(input.edgeId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 ||
        !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) return false;
    const patch = input.patch as Record<string, unknown>;
    return Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['sourcePlacementId', 'targetPlacementId', 'label', 'waypoints', 'style'].includes(key)) &&
      (!('sourcePlacementId' in patch) || uuid.test(String(patch.sourcePlacementId))) && (!('targetPlacementId' in patch) || uuid.test(String(patch.targetPlacementId))) &&
      (!('label' in patch) || typeof patch.label === 'string') && (!('waypoints' in patch) || Array.isArray(patch.waypoints) && patch.waypoints.every(validPoint)) &&
      (!('style' in patch) || !!patch.style && typeof patch.style === 'object' && !Array.isArray(patch.style));
  }
  if (input.action === 'create-drawing') return (Object.keys(input).length === 6 || Object.keys(input).length === 7) &&
    Object.keys(input).every((key) => ['action', 'sessionId', 'workspaceId', 'expectedWorkspaceRevision', 'points', 'parameters', 'style'].includes(key)) &&
    Number.isSafeInteger(input.expectedWorkspaceRevision) && Number(input.expectedWorkspaceRevision) >= 1 && validDrawingPoints(input.points) &&
    validDrawingParameters(input.parameters, false) && (!('style' in input) || validStyle(input.style));
  if (input.action === 'update-drawing') {
    if (Object.keys(input).length !== 6 || !uuid.test(String(input.drawingId)) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 ||
        !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) return false;
    const patch = input.patch as Record<string, unknown>;
    return Object.keys(patch).length > 0 && Object.keys(patch).every((key) => ['points', 'parameters', 'style'].includes(key)) &&
      (!('points' in patch) || validDrawingPoints(patch.points)) && (!('parameters' in patch) || validDrawingParameters(patch.parameters, true)) &&
      (!('style' in patch) || validStyle(patch.style));
  }
  if (input.action === 'delete-drawing') return Object.keys(input).length === 5 && uuid.test(String(input.drawingId)) &&
    Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1;
  if (input.action === 'convert-drawings-to-node') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedWorkspaceRevision) &&
    Number(input.expectedWorkspaceRevision) >= 1 && Array.isArray(input.drawings) && input.drawings.length > 0 && input.drawings.length <= 256 &&
    input.drawings.every((item: unknown) => !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2 &&
      uuid.test(String((item as Record<string, unknown>).id)) && Number.isSafeInteger((item as Record<string, unknown>).expectedRevision) &&
      Number((item as Record<string, unknown>).expectedRevision) >= 1);
  return ['load', 'flush', 'discard', 'approve-edge-delete', 'approve-drawing-delete', 'approve-history-delete'].includes(String(input.action)) && Object.keys(input).length === 3;
}

function validCodeRequest(value: unknown): value is CodeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof input.sessionId !== 'string' || !uuid.test(input.sessionId)) return false;
  if (input.action === 'open') {
    if (Object.keys(input).length !== 3 || !input.target || typeof input.target !== 'object' || Array.isArray(input.target)) return false;
    const target = input.target as Record<string, unknown>;
    return Object.keys(input).every((k) => ['action', 'sessionId', 'target'].includes(k)) &&
      (Object.keys(target).length === 1 && typeof target.itemId === 'string' && uuid.test(target.itemId) ||
        Object.keys(target).every((k) => ['resourceId', 'entityId'].includes(k)) && typeof target.resourceId === 'string' && uuid.test(target.resourceId) &&
        (!('entityId' in target) || typeof target.entityId === 'string' && uuid.test(target.entityId)));
  }
  if (typeof input.documentId !== 'string' || !uuid.test(input.documentId)) return false;
  if (input.action === 'reload') return Object.keys(input).length === 3 && Object.keys(input).every((k) => ['action', 'sessionId', 'documentId'].includes(k));
  return input.action === 'save' && Object.keys(input).length === 6 && Object.keys(input).every((k) => ['action', 'sessionId', 'documentId', 'expectedRevision', 'expectedHash', 'content'].includes(k)) &&
    (input.expectedRevision === null || Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0) &&
    typeof input.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(input.expectedHash) && typeof input.content === 'string' && input.content.length <= 2 * 1024 * 1024;
}
function validMarkdownRequest(value: unknown): value is MarkdownRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(String(input.sessionId)) || !uuid.test(String(input.entityId)) || !uuid.test(String(input.resourceId))) return false;
  if (input.action === 'open') return Object.keys(input).length === 4 && Object.keys(input).every((key) => ['action', 'sessionId', 'entityId', 'resourceId'].includes(key));
  if (input.action === 'asset') return Object.keys(input).length === 5 && Object.keys(input).every((key) => ['action', 'sessionId', 'entityId', 'resourceId', 'reference'].includes(key)) &&
    typeof input.reference === 'string' && input.reference.length > 0 && input.reference.length <= 2048;
  return input.action === 'save' && Object.keys(input).length === 8 && Object.keys(input).every((key) =>
    ['action', 'sessionId', 'entityId', 'resourceId', 'entityRevision', 'expectedRevision', 'expectedHash', 'content'].includes(key)) &&
    Number.isSafeInteger(input.entityRevision) && Number(input.entityRevision) >= 1 && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 &&
    typeof input.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(input.expectedHash) && typeof input.content === 'string' && input.content.length <= 2 * 1024 * 1024;
}
function validDrawingPoints(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 100000 && value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const point = item as Record<string, unknown>;
    return Object.keys(point).every((key) => ['x', 'y', 'pressure'].includes(key)) && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      (!('pressure' in point) || Number.isFinite(point.pressure) && Number(point.pressure) >= 0 && Number(point.pressure) <= 1);
  });
}
function validDrawingParameters(value: unknown, partial: boolean): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>, allowed = ['size', 'thinning', 'smoothing', 'streamline', 'simulatePressure'];
  if (Object.keys(params).some((key) => !allowed.includes(key)) || !Object.keys(params).length) return false;
  if (!partial && allowed.some((key) => !Object.hasOwn(params, key))) return false;
  return (!('size' in params) || Number.isFinite(params.size) && Number(params.size) > 0 && Number(params.size) <= 512) &&
    (!('thinning' in params) || Number.isFinite(params.thinning) && Number(params.thinning) >= -1 && Number(params.thinning) <= 1) &&
    (!('smoothing' in params) || Number.isFinite(params.smoothing) && Number(params.smoothing) >= 0 && Number(params.smoothing) <= 1) &&
    (!('streamline' in params) || Number.isFinite(params.streamline) && Number(params.streamline) >= 0 && Number(params.streamline) <= 1) &&
    (!('simulatePressure' in params) || typeof params.simulatePressure === 'boolean');
}
function validStyle(value: unknown): boolean { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validPoint(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return Object.keys(point).length === 2 && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validRequest(value: unknown): value is ProjectsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { list: [], restore: [], open: [], create: ['name'], recent: ['id'], relocate: ['id'], confirm: ['token'], cancel: ['token'], close: ['sessionId'], rename: ['sessionId', 'name'], 'draft-name': ['sessionId', 'name'] };
  const required = typeof input.action === 'string' && Object.hasOwn(fields, input.action) ? fields[input.action] : undefined;
  return !!required && Object.keys(input).length === required.length + 1 && required.every((key) =>
    typeof input[key] === 'string' && (input[key].length > 0 || input.action === 'draft-name' && key === 'name') && input[key].length <= (key === 'name' ? 120 : 64));
}

export function createProjectController(stateDirectory: string, getWindow: () => BrowserWindow | null, plantumlArtifactPath = join(stateDirectory, PLANTUML_ARTIFACT_FILE)) {
  const authenticatedActor = { kind: 'user' as const, id: 'desktop-local-user' };
  const confirm = async (message: string, detail: string): Promise<boolean> => {
    const parent = getWindow(); if (!parent) return false;
    const result = await dialog.showMessageBox(parent, { type: 'question', title: 'A3 · Proyecto local', message, detail,
      buttons: ['Cancelar', 'Aprobar'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  };
  const capabilities = createProjectCapabilityBroker({ stateDirectory, authenticatedActor,
    confirmUserAction: (request) => confirm('Aprobar permiso del proyecto',
      `Capacidad: ${request.capability}\nAcción: ${request.operation}${request.displayTarget ? '\nCarpeta: ' + request.displayTarget : ''}\nLa aprobación pertenece solo a este proyecto y dispositivo.`) });
  const manager = new LocalProjectManager({ stateDirectory: join(stateDirectory, 'local-projects'), host: { authenticatedActor, capabilities },
    confirmClose: (project) => confirm('Cerrar con cambios externos o recuperación pendiente',
      `${project.name}\n${project.root}\nLos archivos y copias de recuperación se conservarán. La sesión del proyecto se cerrará antes de abrir otra.`) });
  const plantumlRenderer = new PlantUmlRenderer({ artifactPath: plantumlArtifactPath, installDirectory: join(stateDirectory, 'diagram-engines', 'plantuml') });
  const dropDrafts = new Map<string, StagedDrop>();
  const chooseFolder = async (title: string): Promise<string | undefined> => {
    const parent = getWindow(); if (!parent) return undefined;
    const result = await dialog.showOpenDialog(parent, { title, properties: ['openDirectory', 'dontAddToRecent'] });
    return result.canceled ? undefined : result.filePaths[0];
  };
  const validFileRequest = (value: unknown): value is FilesRequest => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    const shapes: Record<string, { required: string[]; optional?: string[] }> = {
      list: { required: ['sessionId'], optional: ['directoryId', 'cursor'] }, open: { required: ['sessionId', 'itemId'] }, 'open-mount': { required: ['sessionId', 'resourceId'] },
      'create-file': { required: ['sessionId', 'parentId', 'name'] }, 'create-folder': { required: ['sessionId', 'parentId', 'name'] },
      rename: { required: ['sessionId', 'itemId', 'name'] }, duplicate: { required: ['sessionId', 'itemId'], optional: ['name'] },
      move: { required: ['sessionId', 'itemId', 'destination'] },
      'preview-delete': { required: ['sessionId', 'itemId'] }, 'cancel-delete': { required: ['sessionId', 'token'] }, 'confirm-delete': { required: ['sessionId', 'token'] },
      'copy-path': { required: ['sessionId', 'itemId', 'kind'] }, 'copy-mount-path': { required: ['sessionId', 'resourceId', 'kind'] }
    };
    const shape = typeof input.action === 'string' && Object.hasOwn(shapes, input.action) ? shapes[input.action]! : undefined;
    if (!shape || Object.keys(input).some((key) => key !== 'action' && !shape.required.includes(key) && !shape.optional?.includes(key)) ||
        shape.required.some((key) => typeof input[key] !== 'string' || input[key] === '' || (input[key] as string).length > (key === 'destination' ? 1024 : key === 'name' ? 255 : 128)) ||
        shape.optional?.some((key) => Object.hasOwn(input, key) && (typeof input[key] !== 'string' || (input[key] as string).length > 512))) return false;
    if (['copy-path', 'copy-mount-path'].includes(String(input.action)) && input.kind !== 'absolute' && input.kind !== 'relative') return false;
    return Object.keys(input).length >= shape.required.length + 1 && (!shape.optional || Object.keys(input).length <= shape.required.length + shape.optional.length + 1);
  };
  const stageDrop = async (value: unknown): Promise<FileDropStageResult> => {
    const fail = (code: string, message: string): FileDropStageResult => ({ ok: false, error: { code, message, recovery: 'A3 no cambió archivos. Arrastra un archivo regular o cancela la operación.' } });
    if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some((path) => typeof path !== 'string')) return fail('DROP_SELECTION_UNSUPPORTED', 'Arrastra hasta 20 archivos o una carpeta a la vez.');
    try {
      for (const [token, draft] of dropDrafts) if (Date.now() - draft.createdAt > 10 * 60_000) dropDrafts.delete(token);
      if (dropDrafts.size >= 20) return fail('DROP_QUEUE_FULL', 'Cancela alguna vista previa de drop pendiente antes de arrastrar otro archivo.');
      const inspected = await Promise.all((value as string[]).map((path) => inspectDropPath(path)));
      const directories = inspected.filter((entry) => entry.kind === 'folder');
      if (directories.length && (directories.length !== 1 || inspected.length !== 1)) return fail('DROP_SELECTION_UNSUPPORTED', 'Suelta una sola carpeta, sin mezclarla con otros elementos.');
      const folder = directories[0];
      const filePaths: { path: string; root: string; relativePath: string; size: number }[] = [];
      if (folder) {
        const visit = async (directory: string): Promise<void> => {
          const before = await inspectDropPath(directory);
          if (before.kind !== 'folder') throw new Error('Una carpeta cambió de identidad durante la vista previa.');
          const entries = await readdir(directory);
          const after = await inspectDropPath(directory);
          if (after.kind !== 'folder' || after.identity !== before.identity) throw new Error('Una carpeta cambió durante la enumeración; no se importó.');
          for (const name of entries.sort((a, b) => a.localeCompare(b))) {
            const candidate = resolve(directory, name), item = await inspectDropPath(candidate);
            if (item.kind === 'folder') await visit(candidate);
            else filePaths.push({ path: candidate, root: folder.path, relativePath: relative(folder.path, candidate).replaceAll('\\', '/'), size: item.size });
            if (filePaths.length > 128) throw new Error('La carpeta contiene más de 128 archivos; divide la importación.');
          }
        };
        await visit(folder.path);
      } else {
        for (const item of inspected) filePaths.push({ path: item.path, root: dirname(item.path), relativePath: basename(item.path), size: item.size });
      }
      if (!filePaths.length) return fail('DROP_EMPTY_FOLDER', 'La carpeta no contiene archivos regulares para importar.');
      const total = filePaths.reduce((sum, file) => sum + file.size, 0);
      if (filePaths.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 10 * 1024 * 1024) || total > 32 * 1024 * 1024) {
        return fail('DROP_FILE_SIZE', 'Cada archivo debe tener entre 1 byte y 10 MiB y la selección no puede superar 32 MiB.');
      }
      const mountRoots = new Map<string, string>();
      const files: StagedDropFile[] = filePaths.map((file) => {
        const rootKey = file.root.toLowerCase();
        let mountId = mountRoots.get(rootKey);
        if (!mountId) { mountId = randomUUID(); mountRoots.set(rootKey, mountId); }
        const name = file.relativePath.split('/').at(-1) ?? basename(file.path);
        const extension = name.toLowerCase().split('.').at(-1) ?? '';
        return { ...file, mountId, resourceId: randomUUID(), name: file.relativePath, mediaType: dropExtensionType[extension] ?? 'application/octet-stream' };
      });
      const token = randomUUID();
      const draft: StagedDrop = { files, kind: folder ? 'folder' : 'file', createdAt: Date.now() };
      dropDrafts.set(token, draft);
      return { ok: true, value: { token, kind: draft.kind, files: files.map((file) => ({ name: file.name, size: file.size,
        copyDestination: `content/${file.resourceId}.bin`, referenceDestination: `.a3/resources/${file.resourceId}.json` })) } };
    } catch (error) { return fail('DROP_PATH_REJECTED', error instanceof Error ? error.message : 'No se pudo validar el archivo arrastrado.'); }
  };
  const smartPaste = async (value: Extract<CanvasRequest, { action: 'smart-paste' }>): Promise<CanvasResult> => {
    try {
      if (value.mode === 'text') {
        const text = await clipboard.readText();
        if (!text.trim()) return { ok: false, error: { code: 'CLIPBOARD_EMPTY', message: 'El portapapeles no contiene texto.', recovery: 'Copia texto o usa Pegado inteligente.' } };
        return { ok: true, value: await manager.createCanvasContentNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision,
          { kind: 'short-text', title: 'Texto pegado', value: text, position: value.position }) };
      }
      const items = await clipboard.read();
      let fragment: string | undefined, image: { bytes: Uint8Array; mediaType: string } | undefined;
      for (const item of items) {
        if (fragment === undefined && item.types.includes('application/x-a3-clipboard-fragment+json')) {
          try { const blob = await item.getType('application/x-a3-clipboard-fragment+json'); fragment = new TextDecoder().decode(await (blob as Blob).arrayBuffer()); }
          catch { /* Invalid custom data falls through to image, URL and text. */ }
        }
        if (!image) {
          const mediaType = item.types.find((type) => /^image\/(?:png|jpeg|webp|gif|avif|bmp|tiff)$/i.test(type));
          if (mediaType) {
            try {
              const blob = await item.getType(mediaType), bytes = Buffer.from(await (blob as Blob).arrayBuffer());
              if (bytes.length > 10 * 1024 * 1024) throw new LocalProjectError('CLIPBOARD_IMAGE_TOO_LARGE', 'La imagen del portapapeles supera 10 MiB.');
              if (bytes.length) image = { bytes: Uint8Array.from(bytes), mediaType };
            } catch (error) { if (error instanceof LocalProjectError) throw error; }
          }
        }
      }
      const resolved = resolveSmartPastePayload({ ...(fragment !== undefined ? { fragment } : {}), ...(image ? { image } : {}), text: await clipboard.readText() });
      if (resolved.kind === 'image') return { ok: true, value: await manager.createCanvasContentNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision,
        { kind: 'image', title: 'Imagen pegada', position: value.position, bytes: resolved.bytes, mediaType: resolved.mediaType }) };
      if (resolved.kind === 'text') {
        if (!resolved.value.trim()) return { ok: false, error: { code: 'CLIPBOARD_EMPTY', message: 'El portapapeles no contiene texto, imagen o fragmento A3 válido.', recovery: 'Copia contenido y vuelve a pegar sobre el fondo del lienzo.' } };
        return { ok: true, value: await manager.createCanvasContentNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision,
          { kind: 'short-text', title: 'Texto pegado', value: resolved.value, position: value.position }) };
      }
      const kind = resolved.kind === 'image-url' ? 'image' : resolved.kind;
      return { ok: true, value: await manager.createCanvasContentNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision,
        { kind, title: resolved.title, url: resolved.value, position: value.position }) };
    } catch (error) {
      return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'PASTE_FAILED',
        message: error instanceof Error ? error.message : 'No se pudo pegar el contenido.', recovery: 'El portapapeles no se modificó y el lienzo permanece intacto.' } };
    }
  };
  return {
    manager,
    async handleCanvas(value: unknown): Promise<CanvasResult | CanvasContentResult | CanvasMermaidImportResult | CanvasPlantUmlResult> {
      if (!validCanvasRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de lienzo inválida.', recovery: 'Reabre el workspace.' } };
      try {
        switch (value.action) {
          case 'plantuml-render': return { ok: true, value: await plantumlRenderer.render(await manager.preparePlantUmlRender(value.sessionId, value.workspaceId, value.sourceEntityId)) };
          case 'mermaid-import-preview': return { ok: true, value: await manager.previewCanvasMermaidImport(value.sessionId, value.workspaceId, value.sourceEntityId) };
          case 'mermaid-import-apply': return { ok: true, value: await manager.applyCanvasMermaidImport(value.sessionId, value.workspaceId, value.token, value.authority) };
          case 'load': return { ok: true, value: await manager.loadCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'stage': return { ok: true, value: await manager.stageCanvasViewport(value.sessionId, value.workspaceId, value.expectedRevision, value.viewport) };
          case 'flush': return { ok: true, value: await manager.flushCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'discard': return { ok: true, value: await manager.discardCanvasViewport(value.sessionId, value.workspaceId) };
          case 'create-placement': return { ok: true, value: await manager.createCanvasPlacement(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.entityId, value.position) };
          case 'create-content-node': return { ok: true, value: await manager.createCanvasContentNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.node) };
          case 'c4': return { ok: true, value: await manager.changeCanvasC4(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.operation) };
          case 'uml': return { ok: true, value: await manager.changeCanvasUml(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.operation) };
          case 'er': return { ok: true, value: await manager.changeCanvasEr(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.operation) };
          case 'create-iot-component': return { ok: true, value: await manager.createCanvasIotComponent(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.catalogId, value.title, value.position) };
          case 'create-iot-circuit': return { ok: true, value: await manager.createCanvasIotCircuit(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.title, value.position) };
          case 'change-iot-circuit': return { ok: true, value: await manager.changeCanvasIotCircuit(value.sessionId, value.workspaceId, value.entityId, value.expectedRevision, value.model) };
          case 'create-conceptual-node': return { ok: true, value: await manager.createCanvasConceptualNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.kind, value.title, value.position) };
          case 'update-conceptual-node': return { ok: true, value: await manager.updateCanvasConceptualNode(value.sessionId, value.workspaceId, value.entityId, value.expectedRevision, value.patch) };
          case 'create-conceptual-relation': return { ok: true, value: await manager.createCanvasConceptualRelation(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision,
            value.sourcePlacementId, value.targetPlacementId, value.label, value.kind) };
          case 'update-conceptual-relation': return { ok: true, value: await manager.updateCanvasConceptualRelation(value.sessionId, value.workspaceId, value.relationId, value.expectedRevision, value.patch) };
          case 'delete-conceptual-relation': return { ok: true, value: await manager.deleteCanvasConceptualRelation(value.sessionId, value.workspaceId, value.relationId, value.expectedRevision) };
          case 'smart-paste': return smartPaste(value);
          case 'cancel-drop': dropDrafts.delete(value.token); return { ok: true, value: await manager.loadCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'drop-file': {
            if (value.mode === 'move') return { ok: false, error: { code: 'MOVE_UNAVAILABLE', message: 'Mover está deshabilitado: E1 no tiene borrado externo seguro por handle en Windows.', recovery: 'Usa Copiar o Referenciar. El archivo externo no se modificó.' } };
            const draft = dropDrafts.get(value.token);
            if (!draft) return { ok: false, error: { code: 'DROP_EXPIRED', message: 'La vista previa del archivo expiró.', recovery: 'Arrastra el archivo otra vez; no se modificó el proyecto.' } };
            if (Date.now() - draft.createdAt > 10 * 60_000) { dropDrafts.delete(value.token); return { ok: false, error: { code: 'DROP_EXPIRED', message: 'La vista previa expiró después de diez minutos.', recovery: 'Arrastra los archivos otra vez; no se modificó el proyecto.' } }; }
            const roots = new Map(draft.files.map((file) => [file.root.toLowerCase(), { root: file.root, mountId: file.mountId }]));
            for (const entry of roots.values()) {
              const approved = await manager.approveCanvasDropMount(value.sessionId, entry.mountId, entry.root);
              if (!approved) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'No se aprobó una carpeta de origen.', recovery: 'Cancela la vista previa o vuelve a aprobar el acceso. No se modificaron los archivos del proyecto.' } };
            }
            let next = await manager.loadCanvasWorkspace(value.sessionId, value.workspaceId);
            let completed = 0;
            try {
              for (const [index, file] of draft.files.entries()) {
                const kind = file.mediaType.startsWith('image/') ? 'image' : file.mediaType.startsWith('video/') ? 'video' : file.mediaType.startsWith('audio/') ? 'audio' : 'file';
                next = await manager.createCanvasContentNode(value.sessionId, value.workspaceId, index ? next.revision : value.expectedWorkspaceRevision, {
                  kind, title: file.name.split('/').at(-1)!.slice(0, 200), position: { x: value.position.x + index * 360, y: value.position.y }, mediaType: file.mediaType,
                  resourceId: file.resourceId, dropMode: value.mode, dropMountId: file.mountId, dropPath: file.relativePath
                });
                completed++;
              }
            } catch (error) {
              if (!completed) throw error;
              draft.files = draft.files.slice(completed);
              return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'DROP_PARTIAL',
                message: `Se añadieron ${completed} elemento(s); el resto se conserva en esta vista previa. ${error instanceof Error ? error.message : ''}`,
                recovery: 'Actualiza el lienzo y reintenta los elementos pendientes o cancela. Cada elemento agregado tiene su nodo y recurso completos.' } };
            }
            dropDrafts.delete(value.token);
            return { ok: true, value: next };
          }
          case 'duplicate-selection': return { ok: true, value: await manager.duplicateCanvasSelection(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.selection, value.mode) };
          case 'undo': return { ok: true, value: await manager.undoCanvas(value.sessionId, value.workspaceId) };
          case 'redo': return { ok: true, value: await manager.redoCanvas(value.sessionId, value.workspaceId) };
          case 'update-placement': return { ok: true, value: await manager.updateCanvasPlacement(value.sessionId, value.workspaceId, value.placementId, value.expectedRevision, value.patch) };
          case 'content': return { ok: true, value: await manager.loadCanvasContent(value.sessionId, value.workspaceId, value.entityId, value.resourceId, value.purpose) };
          case 'move-placements': return { ok: true, value: await manager.moveCanvasPlacements(value.sessionId, value.workspaceId, value.placements) };
          case 'update-placement-views': return { ok: true, value: await manager.updateCanvasPlacementViews(value.sessionId, value.workspaceId, value.placements) };
          case 'create-group': return { ok: true, value: await manager.createCanvasGroup(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.name, value.members) };
          case 'set-group-members': return { ok: true, value: await manager.setCanvasGroupMembers(value.sessionId, value.workspaceId, value.groupId, value.expectedRevision, value.members) };
          case 'rename-group': return { ok: true, value: await manager.renameCanvasGroup(value.sessionId, value.workspaceId, value.groupId, value.expectedRevision, value.name) };
          case 'move-group': return { ok: true, value: await manager.moveCanvasGroup(value.sessionId, value.workspaceId, value.groupId, value.expectedRevision, value.offset) };
          case 'set-group-collapsed': return { ok: true, value: await manager.setCanvasGroupCollapsed(value.sessionId, value.workspaceId, value.groupId, value.expectedRevision, value.collapsed) };
          case 'create-visual-edge': return { ok: true, value: await manager.createCanvasVisualEdge(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.sourcePlacementId, value.targetPlacementId) };
          case 'update-visual-edge': return { ok: true, value: await manager.updateCanvasVisualEdge(value.sessionId, value.workspaceId, value.edgeId, value.expectedRevision, value.patch) };
          case 'delete-visual-edge': return { ok: true, value: await manager.deleteCanvasVisualEdge(value.sessionId, value.workspaceId, value.edgeId, value.expectedRevision) };
          case 'create-drawing': return { ok: true, value: await manager.createCanvasDrawing(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.points, value.parameters, value.style) };
          case 'update-drawing': return { ok: true, value: await manager.updateCanvasDrawing(value.sessionId, value.workspaceId, value.drawingId, value.expectedRevision, value.patch) };
          case 'delete-drawing': return { ok: true, value: await manager.deleteCanvasDrawing(value.sessionId, value.workspaceId, value.drawingId, value.expectedRevision) };
          case 'convert-drawings-to-node': return { ok: true, value: await manager.createCanvasDrawingNode(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.drawings) };
          case 'approve-edge-delete': return { ok: true, value: await manager.approveCanvasEdgeDeletion(value.sessionId, value.workspaceId) };
          case 'approve-drawing-delete': return { ok: true, value: await manager.approveCanvasDrawingDeletion(value.sessionId, value.workspaceId) };
          case 'approve-history-delete': return { ok: true, value: await manager.approveCanvasHistoryDeletion(value.sessionId, value.workspaceId) };
        }
      } catch (error) {
        return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED', message: error instanceof LocalProjectError ? error.message : 'No se pudo completar la operación del lienzo.',
          recovery: ['stage', 'flush', 'discard'].includes(value.action) ? 'La vista pendiente se conserva en la sesión. Reintenta guardar o descártala explícitamente antes de releer.' :
            'Los documentos confirmados se conservan. Recarga el workspace y revisa el conflicto o permiso antes de reintentar.' } };
      }
    },
    async handleCode(value: unknown): Promise<CodeResult> {
      if (!validCodeRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de código inválida.', recovery: 'Abre el archivo desde el explorador o su nodo.' } };
      try {
        const document = value.action === 'open' ? await manager.openCodeDocument(value.sessionId, value.target) : value.action === 'reload'
          ? await manager.reloadCodeDocument(value.sessionId, value.documentId) : await manager.saveCodeDocument(value);
        return { ok: true, value: document };
      } catch (error) { return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED',
        message: error instanceof LocalProjectError ? error.message : 'No se pudo completar la operación de código.',
        recovery: 'El borrador y los bytes guardados se conservan. Compara la versión actual y revisa permisos antes de guardar.' } }; }
    },
    async handleMarkdown(value: unknown): Promise<MarkdownResult> {
      if (!validMarkdownRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud Markdown inválida.', recovery: 'Vuelve a abrir la página desde su nodo.' } };
      try {
        if (value.action === 'open') return { ok: true, value: await manager.openMarkdownDocument(value.sessionId, value.entityId, value.resourceId) };
        if (value.action === 'asset') return { ok: true, value: await manager.openMarkdownImage(value.sessionId, value.entityId, value.resourceId, value.reference) };
        return { ok: true, value: await manager.saveMarkdownDocument(value) };
      } catch (error) {
        return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED',
          message: error instanceof LocalProjectError ? error.message : 'No se pudo completar la operación del documento Markdown.',
          recovery: error instanceof LocalProjectError && ['REVISION_CONFLICT', 'MARKDOWN_ENTITY_MISMATCH', 'STALE_SESSION'].includes(error.code)
            ? 'El borrador permanece en el editor. Copia el texto o recarga la página para resolver el conflicto.'
            : 'La fuente original se conserva. Comprueba permisos, codificación y estado del proyecto antes de reintentar.' } };
      }
    },
    async handle(value: unknown): Promise<ProjectsResult> {
      if (!validRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de proyecto inválida.', recovery: 'Vuelve a realizar la acción desde A3.' } };
      try {
        switch (value.action) {
          case 'list': return { ok: true, value: await manager.getState() };
          case 'restore': return { ok: true, value: await manager.restoreLastProject() };
          case 'create': {
            const folder = await chooseFolder('Elige dónde crear la carpeta del proyecto');
            return { ok: true, value: folder ? await manager.previewCreate(folder, value.name) : await manager.getState() };
          }
          case 'open': {
            const folder = await chooseFolder('Abrir proyecto o incorporar carpeta existente');
            return { ok: true, value: folder ? await manager.openFolder(folder) : await manager.getState() };
          }
          case 'recent': return { ok: true, value: await manager.openRecent(value.id) };
          case 'relocate': {
            const folder = await chooseFolder('Localiza la nueva carpeta del mismo proyecto A3');
            return { ok: true, value: folder ? await manager.relocateRecent(value.id, folder) : await manager.getState() };
          }
          case 'confirm': {
            const state = await manager.getState(); const preview = state.preview;
            if (!preview || preview.token !== value.token) throw new LocalProjectError('STALE_PREVIEW', 'La vista previa cambió. Vuelve a seleccionar el destino.');
            if (!await confirm(preview.kind === 'create' ? 'Crear proyecto A3' : 'Añadir metadatos A3 a esta carpeta',
              `${preview.root}\n\nArchivos nuevos:\n${preview.files.join('\n')}\n\nSe crearán las carpetas indicadas en la vista previa. Los archivos existentes se conservarán. Git es opcional y no se conecta a GitHub.`)) {
              return { ok: true, value: await manager.cancelPreview(value.token) };
            }
            return { ok: true, value: await manager.confirmInitialization(value.token) };
          }
          case 'cancel': return { ok: true, value: await manager.cancelPreview(value.token) };
          case 'rename': return { ok: true, value: await manager.renameActive(value.sessionId, value.name) };
          case 'draft-name': return { ok: true, value: await manager.stageName(value.sessionId, value.name) };
          case 'close': return { ok: true, value: await manager.closeActive(value.sessionId) };
        }
      } catch (error) {
        const code = error instanceof LocalProjectError ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IO_FAILED';
        const message = error instanceof LocalProjectError ? error.message : code === 'ENOENT' ? 'La carpeta o unidad ya no está disponible.' : ['EACCES', 'EPERM'].includes(code) ? 'No tienes permiso para acceder a esta carpeta.' : 'No se pudo completar la operación del proyecto.';
        return { ok: false, error: { code, message, recovery: 'Conecta la unidad, revisa los permisos o localiza la carpeta. Los archivos existentes se conservaron; si hay metadatos pendientes, vuelve a abrir la carpeta para recuperarlos.' } };
      }
    },
    stageDrop,
    async handleNavigation(value: unknown): Promise<NavigationResult> {
      if (!validNavigationRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de enlaces o atajos inválida.', recovery: 'Revisa el contexto y las colisiones de atajos.' } };
      try {
        switch (value.action) {
          case 'index': return { ok: true, value: await manager.navigationIndex(value.sessionId) };
          case 'permissions': return { ok: true, value: await manager.menuPermissions(value.sessionId) };
          case 'resolve': return { ok: true, value: await manager.resolvePageLink(value.sessionId, value.sourceId, value.target, value.kind) };
          case 'copy-link': {
            const index = await manager.navigationIndex(value.sessionId), page = index.pages.find((p) => p.entityId === value.entityId);
            if (!page) throw new LocalProjectError('PAGE_MISSING', 'La página no está disponible en el índice.');
            await clipboard.writeText(`[[${page.entityId}|${page.title.replace(/[\[\]|\r\n]/g, ' ')}]]`); return { ok: true, value: { changed: true } };
          }
          case 'rename-page': await manager.renamePage(value.sessionId, value.entityId, value.expectedRevision, value.title); return { ok: true, value: { changed: true } };
          case 'move-page': await manager.movePage(value.sessionId, value.entityId, value.expectedRevision, value.destination); return { ok: true, value: { changed: true } };
          case 'shortcuts-load': return { ok: true, value: await manager.shortcuts() };
          case 'shortcuts-save': return { ok: true, value: await manager.shortcuts(value.bindings) };
          case 'shortcuts-reset': return { ok: true, value: await manager.shortcuts('reset') };
        }
      } catch (error) { return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED', message: error instanceof Error ? error.message : 'La operación no se completó.', recovery: 'El borrador se conserva. Relee las revisiones y el índice antes de reintentar.' } }; }
    },
    async handleWorkspaceSession(value: unknown): Promise<WorkspaceSessionResult> {
      if (!validSessionRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de pestañas inválida.', recovery: 'Recarga la sesión local.' } };
      try {
        if (value.action === 'reference' || value.action === 'locate') {
          const reference = await manager.pageReference(value.sessionId, value.tabId!);
          if (value.action === 'reference') return { ok: true, value: reference };
          const parent = getWindow(); if (!parent) throw new LocalProjectError('WINDOW_MISSING', 'No hay una ventana para localizar el archivo.');
          if (reference.kind === 'mounted-file' && reference.mountId) {
            const folder = await chooseFolder('Localiza la raíz del montaje de esta página');
            if (!folder) return { ok: true, value: { located: false } };
            const state = await manager.getState();
            if (state.active?.sessionId !== value.sessionId) throw new LocalProjectError('STALE_SESSION', 'La sesión cambió.');
            const granted = await capabilities.approveLocalMount({ root: state.active.root, projectId: state.active.projectId, mountId: reference.mountId, selectedRoot: folder, permission: 'read-only' });
            if (!granted) throw new LocalProjectError('PERMISSION_DENIED', 'El montaje no recibió aprobación local.');
            return { ok: true, value: { located: true } };
          }
          if (reference.kind !== 'project-file') throw new LocalProjectError('RESOURCE_DESCRIPTOR_MISSING', 'Se conserva el ID original. Recupera su descriptor desde el historial antes de localizar su archivo.');
          const chosen = await dialog.showOpenDialog(parent, { title: 'Localiza el Markdown dentro de este proyecto', properties: ['openFile', 'dontAddToRecent'], filters: [{ name: 'Markdown', extensions: ['md'] }] });
          if (chosen.canceled || !chosen.filePaths[0]) return { ok: true, value: { located: false } };
          if (!await confirm('Restablecer referencia de la página', `Recurso: ${reference.resourceId}\nArchivo seleccionado: ${chosen.filePaths[0]}\nSe actualizará la referencia en una transacción, sin mover ni reemplazar el texto.`)) return { ok: true, value: { located: false } };
          await manager.locatePageResource(value.sessionId, value.tabId!, chosen.filePaths[0]);
          return { ok: true, value: { located: true } };
        }
        return { ok: true, value: await manager.workspaceSession(value.sessionId, value, value.action === 'load' ? undefined : value.expectedRevision) };
      } catch (error) { return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED', message: error instanceof Error ? error.message : 'No se pudo guardar la sesión.', recovery: 'Los documentos y la sesión anterior se conservan. Revisa la referencia o reintenta.' } }; }
    },
    async handleFiles(value: unknown): Promise<FilesResult> {
      if (!validFileRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud del explorador inválida.', recovery: 'Actualiza la vista y vuelve a seleccionar el elemento.' } };
      try {
        switch (value.action) {
          case 'list': return { ok: true, value: await manager.listExplorer(value.sessionId, value.directoryId ?? 'project-root', value.cursor) };
          case 'open': return { ok: true, value: await manager.openExplorerItem(value.itemId, value.sessionId) };
          case 'open-mount': return { ok: true, value: await manager.openMountedExplorerResource(value.resourceId, value.sessionId) };
          case 'create-file': await manager.createExplorerItem(value.parentId, value.name, 'file', value.sessionId); return { ok: true, value: { changed: true } };
          case 'create-folder': await manager.createExplorerItem(value.parentId, value.name, 'directory', value.sessionId); return { ok: true, value: { changed: true } };
          case 'rename': await manager.renameExplorerItem(value.itemId, value.name, value.sessionId); return { ok: true, value: { changed: true } };
          case 'move': await manager.moveExplorerItem(value.itemId, value.destination, value.sessionId); return { ok: true, value: { changed: true } };
          case 'duplicate': await manager.duplicateExplorerItem(value.itemId, value.name, value.sessionId); return { ok: true, value: { changed: true } };
          case 'preview-delete': return { ok: true, value: await manager.previewExplorerDelete(value.itemId, value.sessionId) };
          case 'cancel-delete': await manager.cancelExplorerDelete(value.token, value.sessionId); return { ok: true, value: { cancelled: true } };
          case 'confirm-delete': await manager.confirmExplorerDelete(value.token, value.sessionId); return { ok: true, value: { changed: true } };
          case 'copy-path': await clipboard.writeText(await manager.copyExplorerPath(value.itemId, value.kind, value.sessionId)); return { ok: true, value: { copied: true } };
          case 'copy-mount-path': await clipboard.writeText(await manager.copyMountedExplorerPath(value.resourceId, value.kind, value.sessionId)); return { ok: true, value: { copied: true } };
        }
      } catch (error) {
        const code = error instanceof LocalProjectError ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IO_FAILED';
        const message = error instanceof LocalProjectError ? error.message : code === 'ENOENT' ? 'El archivo o carpeta ya no está disponible.' : ['EACCES', 'EPERM'].includes(code) ? 'No tienes permiso para acceder a este elemento.' : 'No se pudo completar la operación de archivos.';
        return { ok: false, error: { code, message, recovery: 'Actualiza el explorador, revisa el permiso del proyecto o vuelve a localizar el montaje. A3 conserva los bytes que no pudo modificar.' } };
      }
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Acción de archivos no reconocida.', recovery: 'Actualiza la vista del explorador.' } };
    }
  };
}

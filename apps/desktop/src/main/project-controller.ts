import { clipboard, dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createProjectCapabilityBroker, LocalProjectManager, LocalProjectError } from '@a3/project-store';
import type { CanvasContentRequest, CanvasContentResult, CanvasRequest, CanvasResult, FilesRequest, FilesResult, ProjectsRequest, ProjectsResult } from '../shared/desktop-api';
import { validViewport } from '../shared/world-viewport';

function validCanvasRequest(value: unknown): value is CanvasRequest | CanvasContentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof input.action !== 'string' || typeof input.sessionId !== 'string' || typeof input.workspaceId !== 'string' || !uuid.test(input.sessionId) || !uuid.test(input.workspaceId)) return false;
  if (input.action === 'stage') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 && validViewport(input.viewport);
  if (input.action === 'create-placement') return Object.keys(input).length === 6 && uuid.test(String(input.entityId)) && Number.isSafeInteger(input.expectedWorkspaceRevision) &&
    Number(input.expectedWorkspaceRevision) >= 1 && !!input.position && typeof input.position === 'object' && !Array.isArray(input.position) &&
    Object.keys(input.position).length === 2 && Number.isFinite((input.position as Record<string, unknown>).x) && Number.isFinite((input.position as Record<string, unknown>).y);
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
  if (input.action === 'content') return Object.keys(input).length === 5 && uuid.test(String(input.entityId)) && uuid.test(String(input.resourceId));
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
  const fields: Record<string, string[]> = { list: [], open: [], create: ['name'], recent: ['id'], relocate: ['id'], confirm: ['token'], cancel: ['token'], close: ['sessionId'], rename: ['sessionId', 'name'], 'draft-name': ['sessionId', 'name'] };
  const required = typeof input.action === 'string' && Object.hasOwn(fields, input.action) ? fields[input.action] : undefined;
  return !!required && Object.keys(input).length === required.length + 1 && required.every((key) =>
    typeof input[key] === 'string' && (input[key].length > 0 || input.action === 'draft-name' && key === 'name') && input[key].length <= (key === 'name' ? 120 : 64));
}

export function createProjectController(stateDirectory: string, getWindow: () => BrowserWindow | null) {
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
      'preview-delete': { required: ['sessionId', 'itemId'] }, 'cancel-delete': { required: ['sessionId', 'token'] }, 'confirm-delete': { required: ['sessionId', 'token'] },
      'copy-path': { required: ['sessionId', 'itemId', 'kind'] }, 'copy-mount-path': { required: ['sessionId', 'resourceId', 'kind'] }
    };
    const shape = typeof input.action === 'string' && Object.hasOwn(shapes, input.action) ? shapes[input.action]! : undefined;
    if (!shape || Object.keys(input).some((key) => key !== 'action' && !shape.required.includes(key) && !shape.optional?.includes(key)) ||
        shape.required.some((key) => typeof input[key] !== 'string' || input[key] === '' || (input[key] as string).length > (key === 'name' ? 255 : 128)) ||
        shape.optional?.some((key) => Object.hasOwn(input, key) && (typeof input[key] !== 'string' || (input[key] as string).length > 512))) return false;
    if (['copy-path', 'copy-mount-path'].includes(String(input.action)) && input.kind !== 'absolute' && input.kind !== 'relative') return false;
    return Object.keys(input).length >= shape.required.length + 1 && (!shape.optional || Object.keys(input).length <= shape.required.length + shape.optional.length + 1);
  };
  return {
    manager,
    async handleCanvas(value: unknown): Promise<CanvasResult | CanvasContentResult> {
      if (!validCanvasRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de lienzo inválida.', recovery: 'Reabre el workspace.' } };
      try {
        switch (value.action) {
          case 'load': return { ok: true, value: await manager.loadCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'stage': return { ok: true, value: await manager.stageCanvasViewport(value.sessionId, value.workspaceId, value.expectedRevision, value.viewport) };
          case 'flush': return { ok: true, value: await manager.flushCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'discard': return { ok: true, value: await manager.discardCanvasViewport(value.sessionId, value.workspaceId) };
          case 'create-placement': return { ok: true, value: await manager.createCanvasPlacement(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.entityId, value.position) };
          case 'duplicate-selection': return { ok: true, value: await manager.duplicateCanvasSelection(value.sessionId, value.workspaceId, value.expectedWorkspaceRevision, value.selection, value.mode) };
          case 'undo': return { ok: true, value: await manager.undoCanvas(value.sessionId, value.workspaceId) };
          case 'redo': return { ok: true, value: await manager.redoCanvas(value.sessionId, value.workspaceId) };
          case 'update-placement': return { ok: true, value: await manager.updateCanvasPlacement(value.sessionId, value.workspaceId, value.placementId, value.expectedRevision, value.patch) };
          case 'content': return { ok: true, value: await manager.loadCanvasContent(value.sessionId, value.workspaceId, value.entityId, value.resourceId) };
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
    async handle(value: unknown): Promise<ProjectsResult> {
      if (!validRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de proyecto inválida.', recovery: 'Vuelve a realizar la acción desde A3.' } };
      try {
        switch (value.action) {
          case 'list': return { ok: true, value: await manager.getState() };
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
          case 'duplicate': await manager.duplicateExplorerItem(value.itemId, value.name, value.sessionId); return { ok: true, value: { changed: true } };
          case 'preview-delete': return { ok: true, value: await manager.previewExplorerDelete(value.itemId, value.sessionId) };
          case 'cancel-delete': await manager.cancelExplorerDelete(value.token, value.sessionId); return { ok: true, value: { cancelled: true } };
          case 'confirm-delete': await manager.confirmExplorerDelete(value.token, value.sessionId); return { ok: true, value: { changed: true } };
          case 'copy-path': clipboard.writeText(await manager.copyExplorerPath(value.itemId, value.kind, value.sessionId)); return { ok: true, value: { copied: true } };
          case 'copy-mount-path': clipboard.writeText(await manager.copyMountedExplorerPath(value.resourceId, value.kind, value.sessionId)); return { ok: true, value: { copied: true } };
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

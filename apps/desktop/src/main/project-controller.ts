import { clipboard, dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createProjectCapabilityBroker, LocalProjectManager, LocalProjectError } from '@a3/project-store';
import type { CanvasRequest, CanvasResult, FilesRequest, FilesResult, ProjectsRequest, ProjectsResult } from '../shared/desktop-api';
import { validViewport } from '../shared/world-viewport';

function validCanvasRequest(value: unknown): value is CanvasRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof input.action !== 'string' || typeof input.sessionId !== 'string' || typeof input.workspaceId !== 'string' || !uuid.test(input.sessionId) || !uuid.test(input.workspaceId)) return false;
  if (input.action === 'stage') return Object.keys(input).length === 5 && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 && validViewport(input.viewport);
  return ['load', 'flush', 'discard'].includes(String(input.action)) && Object.keys(input).length === 3;
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
    async handleCanvas(value: unknown): Promise<CanvasResult> {
      if (!validCanvasRequest(value)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud de lienzo inválida.', recovery: 'Reabre el workspace.' } };
      try {
        switch (value.action) {
          case 'load': return { ok: true, value: await manager.loadCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'stage': return { ok: true, value: await manager.stageCanvasViewport(value.sessionId, value.workspaceId, value.expectedRevision, value.viewport) };
          case 'flush': return { ok: true, value: await manager.flushCanvasWorkspace(value.sessionId, value.workspaceId) };
          case 'discard': return { ok: true, value: await manager.discardCanvasViewport(value.sessionId, value.workspaceId) };
        }
      } catch (error) {
        return { ok: false, error: { code: error instanceof LocalProjectError ? error.code : 'IO_FAILED', message: error instanceof LocalProjectError ? error.message : 'No se pudo guardar la vista del workspace.',
          recovery: 'La vista pendiente se conserva en la sesión. Reintenta guardar o descártala explícitamente antes de releer.' } };
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

import { dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createProjectCapabilityBroker, LocalProjectManager, LocalProjectError } from '@a3/project-store';
import type { ProjectsRequest, ProjectsResult } from '../shared/desktop-api';

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
  return {
    manager,
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
    }
  };
}

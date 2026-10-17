import { LocalProjectError, type LocalProjectManager } from '@a3/project-store';
import { validHistoryRequest, type HistoryResult } from '../shared/history.ts';

/** Local snapshots are prepared and applied only by the project store; renderer tokens are opaque. */
export class ProjectHistoryController {
  constructor(private readonly manager: LocalProjectManager) {}
  async handle(input: unknown): Promise<HistoryResult> {
    if (!validHistoryRequest(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'La solicitud de historial no es válida.', recovery: 'Vuelve a cargar el historial del proyecto activo.' } };
    try {
      if (input.action === 'load') return { ok: true, value: await this.manager.listHistorySnapshots(input.sessionId) };
      if (input.action === 'preview') return { ok: true, value: await this.manager.prepareHistoryRestore(input.sessionId, input.snapshotId) };
      if (input.action === 'cancel') { await this.manager.cancelHistoryRestore(input.sessionId, input.token); return { ok: true, value: { cancelled: true } }; }
      return { ok: true, value: await this.manager.applyHistoryRestore(input.sessionId, input.token) };
    } catch (error) {
      const code = error instanceof LocalProjectError ? error.code : 'HISTORY_FAILED';
      return { ok: false, error: { code, message: error instanceof Error ? error.message : 'No se completó la operación de historial.',
        recovery: code === 'RESTORE_CONFLICT' || code === 'REVISION_CONFLICT' ? 'Se conservaron los archivos. Actualiza el historial y vuelve a generar la vista previa.' :
          'Los snapshots originales se conservaron. Revisa permisos, estado del proyecto y journal antes de reintentar.' } };
    }
  }
}

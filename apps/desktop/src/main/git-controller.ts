import type { BrowserWindow } from 'electron';
import type { Actor } from '@a3/domain';
import type { LocalProjectManager, ProjectCapabilityBroker } from '@a3/project-store';
import { validGitRequest, type GitResult } from '../shared/git-operations.ts';
import { inspectGitInstallation, GitStatusError } from './git-process.ts';
import { LocalGitVersions } from './git-versions.ts';

export class GitProjectController {
  private active?: { sessionId: string; service: Promise<LocalGitVersions> };
  constructor(private readonly manager: LocalProjectManager, private readonly broker: ProjectCapabilityBroker, private readonly actor: Actor, private readonly getWindow: () => BrowserWindow | null) {}
  async handle(input: unknown): Promise<GitResult> {
    if (!validGitRequest(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud Git inválida.' } };
    try {
      const current = async () => {
        const active = (await this.manager.getState()).active;
        if (!active || active.sessionId !== input.sessionId) throw new GitStatusError('stale-session');
        return active;
      };
      const project = await current();
      if (this.active?.sessionId !== input.sessionId) {
        const create = async () => LocalGitVersions.open(await inspectGitInstallation(), { repositoryId: 'project', projectId: project.projectId, kind: 'a3-project', root: project.root }, {
          authorize: async (capability, stage) => {
            const now = await current();
            if (now.root !== project.root || now.projectId !== project.projectId || !['git.status', 'git.diff'].includes(capability) && (now.mode !== 'writer' || now.pendingName || now.pendingViewport || now.externalConflict)) return false;
            const decision = await this.broker.authorizeCapabilities(project.root, this.actor, project.projectId, ['project.read', capability], capability, stage);
            return decision.allowed;
          },
          hasDirtyBuffers: async () => {
            const window = this.getWindow(); if (!window || window.isDestroyed()) return true;
            // Only the trusted local shell is queried. A false event result means an editor has a draft.
            return !await window.webContents.executeJavaScript("window.dispatchEvent(new Event('beforeunload', { cancelable: true }))");
          },
          prepareRestore: async (operationId, files) => {
            const plan = await this.manager.prepareGitRestore(input.sessionId, { operationId, files });
            return { paths: plan.changes.map((change) => change.path), images: plan.changes.map((change) => ({ path: change.path, bytes: plan.proposedBytes(change.path) })), snapshotId: plan.operationId, apply: () => this.manager.commitGitRestore(input.sessionId, plan) };
          }
        });
        this.active = { sessionId: input.sessionId, service: create() };
      }
      const pending = this.active;
      let service: LocalGitVersions;
      try { service = await pending.service; } catch (error) { if (this.active === pending) this.active = undefined; throw error; }
      if (input.action === 'cancel') { service.cancel(input.token); return { ok: true, value: { cancelled: true } }; }
      return { ok: true, value: input.action === 'load' ? await service.load() : input.action === 'review' ? await service.review(input.input) : await service.apply(input.token, input.hunkIds) };
    } catch (error) {
      const code = error instanceof GitStatusError ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'GIT_FAILED';
      const messages: Record<string, string> = {
        'review-conflict': 'El índice, HEAD o un archivo cambió después de la revisión. Conserva tus cambios y genera otra revisión.',
        'unsaved-changes': 'Hay cambios sin guardar en un editor. Guarda o cancela el borrador antes de revisar Git.',
        'permission-denied': 'La capacidad Git no está concedida para este proyecto. Revisa el perfil efectivo en Preferencias.',
        'secret-detected': 'Se detectó un posible secreto. La revisión y la operación están bloqueadas.',
        'protected-path': 'La selección contiene datos locales, caché o archivos de credenciales excluidos.',
        'protected-tracked-files': 'El índice contiene archivos protegidos. Revisa sus exclusiones fuera de esta operación antes de crear un commit.',
        'unresolved-conflict': 'Hay conflictos Git sin resolver. Se conserva el índice y el contenido.',
        'operation-in-progress': 'Hay un merge, rebase u otra operación Git en curso.',
        'repository-busy': 'Otro proceso mantiene index.lock. No se ha eliminado su bloqueo.',
        'unsupported-repository': 'Este repositorio usa enlaces, filtros/LFS o configuración que el adaptador no admite todavía.',
        'not-installed': 'Git no está instalado en la ubicación opcional configurada.',
        'unverified-binary': 'La versión o huella de Git no coincide con el motor comprobado.'
      };
      return { ok: false, error: { code, message: messages[code] ?? `No se completó la operación Git (${code}). Revisa permisos, selección y estado; no repitas una operación de resultado incierto automáticamente.` } };
    }
  }
}

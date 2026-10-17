import { clipboard, dialog, safeStorage, shell, type BrowserWindow } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Actor } from '@a3/domain';
import type { LocalProjectManager, ProjectCapabilityBroker } from '@a3/project-store';
import { validGithubRequest, type GithubResult } from '../shared/github-publishing.ts';
import { GithubPublishing } from './github-publishing.ts';
import { GithubError, OfficialGithubApi, githubDestination, githubNeed } from './github-api.ts';
import { ProtectedGithubVault, validGithubToken } from './github-vault.ts';
import { inspectGitInstallation, runGithubStaging, forgetGithubStaging } from './git-process.ts';
import type { GitProjectController } from './git-controller.ts';
import type { GitAutomationPublisher } from './git-automation.ts';

export class GithubProjectController {
  private readonly vault: ProtectedGithubVault;
  private readonly api = new OfficialGithubApi();
  private readonly publishing: GithubPublishing;
  private readonly unsubscribe: () => void;
  private readonly pendingConnections = new Set<AbortController>();
  private connectionBusy = false;
  private credentialQueue: Promise<unknown> = Promise.resolve();
  constructor(userData: string, private readonly manager: LocalProjectManager, private readonly broker: ProjectCapabilityBroker, private readonly actor: Actor, private readonly window: () => BrowserWindow | null, private readonly git: GitProjectController) {
    this.vault = new ProtectedGithubVault(userData, safeStorage);
    this.publishing = new GithubPublishing(this.api, this.vault, {
      context: async (sessionId) => { const project = await this.current(sessionId); githubNeed(project.mode === 'writer' && !project.pendingName && !project.pendingViewport && !project.externalConflict, 'project-not-ready'); return { root: project.root, projectId: project.projectId }; },
      authorize: (sessionId, stage) => this.authorize(sessionId, stage),
      source: (sessionId) => this.git.publishingSource(sessionId),
      confirm: async (review) => this.confirm('Confirmar destino de publicación', `Cuenta: ${review.account.login}\nRaíz: ${review.root}\nURL: ${review.url}\nVisibilidad: ${review.visibility}\nRama destino: ${review.branch}\nCommit: ${review.commit}\nAcción: ${review.kind}\nExclusiones: ${review.exclusions.join(', ')}\n${review.kind === 'create' ? 'Crear no sube archivos; un push exige otra revisión.' : 'Sube el commit y su historia alcanzable. No hace force push.'}`),
      push: async (input, signal) => {
        const installation = await inspectGitInstallation(); githubNeed(installation.state === 'available', installation.state); if (installation.state !== 'available') return;
        const directory = await mkdtemp(join(tmpdir(), 'a3-github-push-'));
        try {
          await runGithubStaging(installation.binary, directory, { kind: 'init' }, signal);
          await runGithubStaging(installation.binary, directory, { kind: 'unpack', pack: input.pack }, signal);
          await runGithubStaging(installation.binary, directory, { kind: 'push', url: input.url, branch: input.branch, oid: input.head, token: input.token }, signal);
        } finally {
          forgetGithubStaging(directory);
          const target = resolve(directory); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('a3-github-push-')) throw new GithubError('invalid-staging');
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    });
    this.unsubscribe = broker.subscribeRevocations(() => this.cancelAll());
  }
  cancelAll(): void { this.publishing.cancelAll(); for (const controller of this.pendingConnections) controller.abort(); }
  async automationPublisher(sessionId: string): Promise<GitAutomationPublisher | undefined> {
    try { await this.current(sessionId); if (!this.vault.available() || !await this.vault.read()) return undefined; }
    catch { return undefined; }
    const authorizeDirect = async (): Promise<void> => {
      const project = await this.current(sessionId);
      githubNeed(project.mode === 'writer' && !project.pendingName && !project.pendingViewport && !project.externalConflict, 'project-not-ready');
      const state = this.broker.getPolicyState({ root: project.root, projectId: project.projectId });
      const push = state.capabilities.find((entry) => entry.capability === 'git.push');
      githubNeed(push?.available && push.effectiveMode === 'direct', 'permission-denied');
      githubNeed(await this.authorize(sessionId, 'apply'), 'permission-denied');
    };
    const verify = async (destinationUrl: string, branch: string, head?: string): Promise<void> => {
      await authorizeDirect();
      const destination = githubDestination(destinationUrl), token = await this.vault.read(); githubNeed(token, 'authorization-expired');
      await this.api.user(token!);
      const remote = await this.api.repository(token!, destination.url);
      githubNeed(remote.fullName.toLowerCase() === `${destination.owner}/${destination.name}`.toLowerCase() && remote.canPush, 'remote-permission-denied');
      const source = await this.git.publishingSource(sessionId), snapshot = await source.snapshot();
      githubNeed(snapshot.branch === branch && (!head || snapshot.head === head), 'destination-mismatch');
      const remoteHead = await this.api.branchHead?.(token!, destination.url, branch);
      if (remoteHead) githubNeed(await source.containsCommit(remoteHead), 'remote-conflict');
    };
    return {
      check: verify,
      publish: async (destinationUrl, branch, head, signal) => {
        await verify(destinationUrl, branch, head);
        const token = await this.vault.read(); githubNeed(token, 'authorization-expired');
        const source = await this.git.publishingSource(sessionId), snapshot = await source.snapshot();
        githubNeed(snapshot.branch === branch && snapshot.head === head, 'destination-mismatch');
        const pack = await source.pack(head), installation = await inspectGitInstallation(); if (installation.state !== 'available') throw new GithubError(installation.state);
        const staging = await mkdtemp(join(tmpdir(), 'a3-github-auto-'));
        const boundedSignal = (): AbortSignal => signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
        try {
          await runGithubStaging(installation.binary, staging, { kind: 'init' }, boundedSignal());
          await runGithubStaging(installation.binary, staging, { kind: 'unpack', pack }, boundedSignal());
          await authorizeDirect();
          const renewed = await this.vault.read(); githubNeed(renewed && renewed === token, 'authorization-expired');
          await runGithubStaging(installation.binary, staging, { kind: 'push', url: destinationUrl, branch, oid: head, token: renewed! }, boundedSignal());
        } finally {
          forgetGithubStaging(staging);
          const target = resolve(staging); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('a3-github-auto-')) throw new GithubError('invalid-staging');
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    };
  }
  dispose(): void { this.cancelAll(); this.unsubscribe(); }
  private mutateCredentials(action: () => Promise<void>): Promise<void> { const next = this.credentialQueue.then(action); this.credentialQueue = next.catch(() => undefined); return next; }
  private async current(sessionId: string) { const active = (await this.manager.getState()).active; githubNeed(active?.sessionId === sessionId, 'stale-session'); return active!; }
  private async authorize(sessionId: string, stage: 'prepare' | 'apply'): Promise<boolean> {
    const active = await this.current(sessionId);
    return (await this.broker.authorizeCapabilities(active.root, this.actor, active.projectId, ['project.read', 'git.push'], 'github.publish', stage)).allowed;
  }
  private async confirm(message: string, detail: string): Promise<boolean> {
    const parent = this.window(); if (!parent || parent.isDestroyed()) return false;
    return (await dialog.showMessageBox(parent, { type: 'question', title: 'A3 · GitHub', message, detail, buttons: ['Cancelar', 'Confirmar'], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
  }
  async handle(input: unknown): Promise<GithubResult> {
    if (!validGithubRequest(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud GitHub inválida.' } };
    try {
      await this.current(input.sessionId);
      if (input.action === 'cancel') { this.publishing.cancel(input.sessionId, input.token); return { ok: true, value: { completed: 'cancelled' } }; }
      if (input.action === 'disconnect') { this.cancelAll(); await this.mutateCredentials(() => this.vault.clear()); return { ok: true, value: { completed: 'disconnected' } }; }
      if (input.action === 'manual-help') {
        if (await this.confirm('Abrir flujo manual en tu navegador', 'A3 no tiene OAuth de GitHub configurado. Puedes crear un repositorio vacío y autenticarte con tus herramientas Git externas. No se configura remote ni se envía contenido automáticamente.')) await shell.openExternal('https://github.com/new');
        return { ok: true, value: { completed: 'help' } };
      }
      githubNeed(await this.authorize(input.sessionId, 'prepare'), 'permission-denied');
      if (input.action === 'connect-manual') {
        githubNeed(!this.connectionBusy, 'authorization-busy'); this.connectionBusy = true; const controller = new AbortController(); this.pendingConnections.add(controller);
        try {
          githubNeed(this.vault.available(), 'protected-storage-unavailable');
          githubNeed(await this.confirm('Importar token personal de GitHub', 'Sin OAuth configurado. Copia tu token personal al portapapeles y confirma. Solo el host lo leerá, verificará tu cuenta en api.github.com y lo guardará cifrado con Windows DPAPI, fuera del proyecto. Se limpia el texto actual del portapapeles si coincide. El historial del portapapeles de Windows es independiente. No pegues el token en un archivo ni en el chat.'), 'cancelled');
          await this.current(input.sessionId); githubNeed(!controller.signal.aborted && await this.authorize(input.sessionId, 'apply'), 'permission-denied');
          const token = (await clipboard.readText()).trim(); githubNeed(validGithubToken(token), 'invalid-token');
          const account = await this.api.user(token, controller.signal); await this.current(input.sessionId); githubNeed(!controller.signal.aborted && await this.authorize(input.sessionId, 'prepare'), 'permission-denied');
          this.publishing.cancelAll(); await this.mutateCredentials(async () => {
            githubNeed(!controller.signal.aborted, 'cancelled'); await this.vault.save(token);
            if (controller.signal.aborted) { await this.vault.clear(); throw new GithubError('cancelled'); }
          });
          if ((await clipboard.readText()).trim() === token) await clipboard.clear();
          return { ok: true, value: { state: 'connected', account, protectedStorage: true } };
        } finally { this.connectionBusy = false; this.pendingConnections.delete(controller); }
      }
      if (input.action === 'status') return { ok: true, value: await this.publishing.status() };
      if (input.action === 'review') return { ok: true, value: await this.publishing.review(input.sessionId, input) };
      if (input.action === 'apply') return { ok: true, value: await this.publishing.apply(input.sessionId, input.token, input.confirmedUrl) };
      throw new GithubError('invalid-request');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && /^[a-z][a-z-]{1,64}$/.test(String(error.code)) ? String(error.code) : 'github-unavailable';
      const messages: Record<string, string> = {
        cancelled: 'Operación cancelada. No se autoriza un nuevo envío.', 'permission-denied': 'Publicar Git no está concedido. Revisa el perfil efectivo del proyecto.',
        'manual-authorization-required': 'Sin OAuth configurado: conecta manualmente un token personal o usa Git en tu entorno externo.',
        'protected-storage-unavailable': 'El almacén protegido de Windows no está disponible. Usa el flujo externo; A3 no guarda tokens en texto.',
        'destination-mismatch': 'El destino cambió o no coincide con la revisión. Genera otra revisión.', 'visibility-mismatch': 'La visibilidad de GitHub no coincide con la elegida. Verifica el destino y vuelve a revisar.',
        'remote-result-uncertain': 'El envío pudo haber llegado a GitHub. Comprueba el repositorio y la rama antes de repetir; A3 no reintenta automáticamente.',
        'history-secret-or-lfs': 'El historial alcanzable contiene posibles secretos o punteros LFS no soportados. No se publica.',
        'protected-history': 'El historial contiene archivos excluidos, incluso si se borraron después. No se publica.',
        'remote-permission-denied': 'GitHub denegó el permiso o el repositorio no admite escritura.', 'authorization-expired': 'La autorización expiró o fue revocada; conecta de nuevo.'
      };
      return { ok: false, error: { code, message: messages[code] ?? `GitHub no completó la operación (${code}). Conserva el proyecto local y revisa cuenta, destino y permisos.` } };
    }
  }
}

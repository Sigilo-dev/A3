import type { BrowserWindow } from 'electron';
import { stat } from 'node:fs/promises';
import type { Actor } from '@a3/domain';
import type { LocalProjectManager, ProjectCapabilityBroker } from '@a3/project-store';
import { validGitRequest, type GitResult, type GitAutomationSnapshot, type GitAutomationRequest } from '../shared/git-operations.ts';
import { inspectGitInstallation, GitStatusError } from './git-process.ts';
import { LocalGitVersions } from './git-versions.ts';
import { GitAutomationStore, GitAutomationError, runGitAutomationBatch, resumeGitAutomationPush, validateGitAutomationPolicy, type GitAutomationPublisher } from './git-automation.ts';

export class GitProjectController {
  private boundSessionId?: string;
  private readonly services = new Map<string, { root: string; identity: string; service: Promise<LocalGitVersions> }>();
  private readonly automationStore?: GitAutomationStore;
  private automationPublisherFor?: (sessionId: string) => Promise<GitAutomationPublisher | undefined>;
  private readonly automationQueues = new Map<string, Promise<unknown>>();
  private readonly automationAborts = new Set<AbortController>();
  private readonly unsubscribeRevocations: () => void;
  constructor(private readonly manager: LocalProjectManager, private readonly broker: ProjectCapabilityBroker, private readonly actor: Actor, private readonly getWindow: () => BrowserWindow | null, userDataDirectory?: string) {
    if (userDataDirectory) this.automationStore = new GitAutomationStore(userDataDirectory);
    this.unsubscribeRevocations = broker.subscribeRevocations(() => { for (const controller of this.automationAborts) controller.abort(); });
  }
  setAutomationPublisher(factory: (sessionId: string) => Promise<GitAutomationPublisher | undefined>): void { this.automationPublisherFor = factory; }
  dispose(): void { this.unsubscribeRevocations(); for (const controller of this.automationAborts) controller.abort(); this.automationAborts.clear(); this.services.clear(); this.automationQueues.clear(); }
  private serializeAutomation<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.automationQueues.get(key) ?? Promise.resolve(), operation = previous.catch(() => undefined).then(action);
    this.automationQueues.set(key, operation); void operation.finally(() => { if (this.automationQueues.get(key) === operation) this.automationQueues.delete(key); }).catch(() => undefined);
    return operation;
  }
  async publishingSource(sessionId: string): Promise<{ snapshot(): ReturnType<LocalGitVersions['publishingSnapshot']>; pack(head: string): Promise<Buffer>; containsCommit(oid: string): Promise<boolean> }> {
    const loaded = await this.handle({ action: 'load', sessionId }); if (!loaded.ok) throw new GitStatusError(loaded.error.code);
    const service = await this.serviceFor(sessionId);
    return { snapshot: () => service.publishingSnapshot(), pack: (head) => service.publishingPack(head), containsCommit: (oid) => service.containsCommit(oid) };
  }
  private async current(sessionId: string) {
    const active = (await this.manager.getState()).active;
    if (!active || active.sessionId !== sessionId) throw new GitStatusError('stale-session');
    return active;
  }
  private async serviceFor(sessionId: string, mountId?: string): Promise<LocalGitVersions> {
    const project = await this.current(sessionId);
    if (this.boundSessionId !== sessionId) { this.services.clear(); this.boundSessionId = sessionId; }
    const binding = mountId ? await this.manager.resolveGitMountBinding(sessionId, mountId) : undefined;
    if (mountId && (!binding || binding.status !== 'available' || !binding.capabilities.git)) throw new GitStatusError(binding?.status === 'root-missing' ? 'mount-root-missing' : binding?.status === 'root-changed' ? 'mount-root-changed' : 'permission-denied');
    const root = binding?.canonicalRoot ?? project.root, identity = binding?.rootIdentity ?? project.projectId;
    const key = mountId ? `mount:${mountId.toLowerCase()}` : 'project';
    const existing = this.services.get(key);
    if (existing && existing.root === root && existing.identity === identity) return existing.service;
    const repositoryId = mountId ? `mount-${mountId.toLowerCase()}` : 'project';
    const create = async () => LocalGitVersions.open(await inspectGitInstallation(), { repositoryId, projectId: project.projectId,
      kind: mountId ? 'referenced' : 'a3-project', root }, {
      authorize: async (capability, stage) => {
        const now = await this.current(sessionId);
        if (now.root !== project.root || now.projectId !== project.projectId ||
            !['git.status', 'git.diff'].includes(capability) && (now.mode !== 'writer' || now.pendingName || now.pendingViewport || now.externalConflict)) return false;
        if (mountId) {
          const latest = await this.manager.resolveGitMountBinding(sessionId, mountId);
          if (latest.status !== 'available' || !latest.capabilities.git || latest.rootIdentity !== identity || latest.canonicalRoot !== root || capability === 'git.restore') return false;
        }
        const decision = await this.broker.authorizeCapabilities(project.root, this.actor, project.projectId, ['project.read', capability], capability, stage);
        return decision.allowed;
      },
      hasDirtyBuffers: async () => {
        const window = this.getWindow(); if (!window || window.isDestroyed()) return true;
        return !await window.webContents.executeJavaScript("window.dispatchEvent(new Event('beforeunload', { cancelable: true }))");
      },
      prepareRestore: async (operationId, files) => {
        if (mountId) throw new GitStatusError('external-restore-denied');
        const plan = await this.manager.prepareGitRestore(sessionId, { operationId, files });
        return { paths: plan.changes.map((change) => change.path), images: plan.changes.map((change) => ({ path: change.path, bytes: plan.proposedBytes(change.path) })), snapshotId: plan.operationId, apply: () => this.manager.commitGitRestore(sessionId, plan) };
      }
    });
    const service = create(); this.services.set(key, { root, identity, service }); return service;
  }
  private async automationBinding(sessionId: string, mountId?: string) {
    const project = await this.current(sessionId);
    if (mountId) {
      const binding = await this.manager.resolveGitMountBinding(sessionId, mountId);
      if (binding.status !== 'available' || !binding.capabilities.git) throw new GitStatusError(binding.status === 'available' ? 'permission-denied' : `mount-${binding.status}`);
      return { project, root: binding.canonicalRoot, identity: binding.rootIdentity, label: `Montaje ${mountId}`, pushAvailable: false };
    }
    const observed = await stat(project.root);
    return { project, root: project.root, identity: `${observed.dev}:${observed.ino}`, label: project.name, pushAvailable: true };
  }
  private directCapabilities(root: string, projectId: string, mounted: boolean) {
    const state = this.broker.getPolicyState({ root, projectId });
    const direct = (capability: string): boolean => state.capabilities.some((entry) => entry.capability === capability && entry.available && entry.effectiveMode === 'direct');
    return { stage: direct('git.stage'), commit: direct('git.commit'), push: direct('git.push') && !mounted };
  }
  private async automation(input: GitAutomationRequest): Promise<GitResult> {
    try {
      if (!this.automationStore) throw new GitAutomationError('automation-storage-unavailable');
      const binding = await this.automationBinding(input.sessionId, input.mountId), service = await this.serviceFor(input.sessionId, input.mountId);
      const bindingHash = this.automationStore.bindingHash(`${binding.project.projectId}\0${binding.project.root}\0${input.mountId ?? 'project'}\0${binding.identity}\0${binding.root}`);
      const loaded = await service.load(), stored = await this.automationStore.read(bindingHash, loaded.status.branch ?? 'main');
      if (input.action === 'automation-save') {
        const policy = validateGitAutomationPolicy(input.policy);
        if (input.mountId && policy.pushAfterCommit) throw new GitAutomationError('mounted-push-unavailable');
        for (const controller of this.automationAborts) controller.abort();
        return await this.serializeAutomation(bindingHash, async () => {
          const latest = await this.automationStore!.read(bindingHash, loaded.status.branch ?? 'main');
          if (latest.corrupt) throw new GitAutomationError('automation-settings-corrupt');
          await this.automationStore!.write(bindingHash, policy, latest.run);
          return { ok: true, value: { saved: true } };
        });
      }
      if (input.action === 'automation-preview') {
        const policy = stored.policy;
        const entries = loaded.status.state === 'ready' ? loaded.status.entries : [];
        const paths = [...new Set(entries.filter((entry) => policy.paths.includes(entry.path)).map((entry) => entry.path))];
        if (!paths.length) return { ok: true, value: { preview: true, branch: loaded.status.branch ?? null, files: [], diffs: [] } };
        if (entries.some((entry) => entry.index !== '.' && !policy.paths.includes(entry.path))) throw new GitAutomationError('unselected-staged-changes');
        const diffs = [], tokens: string[] = [];
        try {
          const unstaged = entries.filter((entry) => policy.paths.includes(entry.path) && (entry.worktree !== '.' || entry.kind === 'untracked')).map((entry) => entry.path);
          const staged = entries.filter((entry) => policy.paths.includes(entry.path) && entry.index !== '.').map((entry) => entry.path);
          if (unstaged.length) { const review = await service.review({ kind: 'stage', paths: unstaged }); tokens.push(review.token); diffs.push(...review.diffs); }
          if (staged.length) { const review = await service.review({ kind: 'commit', message: 'chore: preview automatic batch', name: 'A3 preview', email: 'a3-preview@example.invalid' }); tokens.push(review.token); diffs.push(...review.diffs); }
          return { ok: true, value: { preview: true, branch: loaded.status.branch ?? null, files: paths, diffs } };
        } finally { for (const token of tokens) service.cancel(token); }
      }
      if (input.action === 'automation-resume') {
        if (input.mountId) throw new GitAutomationError('mounted-push-unavailable');
        return await this.serializeAutomation(bindingHash, async () => {
          const latest = await this.automationStore!.read(bindingHash, loaded.status.branch ?? 'main');
          if (latest.corrupt) throw new GitAutomationError('automation-settings-corrupt');
          const publisher = await this.automationPublisherFor?.(input.sessionId), capabilities = this.directCapabilities(binding.project.root, binding.project.projectId, false), abort = new AbortController();
          this.automationAborts.add(abort);
          try {
            if (latest.run?.state === 'blocked' && !latest.run.commit && ['authorization-expired', 'authorization-unavailable', 'remote-unavailable', 'github-unavailable', 'remote-conflict', 'remote-permission-denied'].includes(latest.run.code ?? '')) {
              if (latest.policy.pushAfterCommit) {
                if (!capabilities.push) throw new GitAutomationError('push-permission-denied');
                if (!publisher) throw new GitAutomationError('authorization-unavailable');
                const currentView = await service.load();
                await publisher.check(latest.policy.destinationUrl!, latest.policy.branch, currentView.status.head ?? undefined);
              }
              await this.automationStore!.write(bindingHash, latest.policy);
              const git = { load: () => service.load(), fingerprint: (paths: readonly string[]) => service.automationFingerprint(paths), review: (value: Parameters<LocalGitVersions['review']>[0]) => service.review(value),
                apply: (token: string) => service.apply(token), cancel: async (token: string) => { service.cancel(token); }, commitMessage: (oid: string) => service.automationCommitMessage(oid) };
              const started = await runGitAutomationBatch({ bindingHash, policy: latest.policy, git, publisher, pushAvailable: binding.pushAvailable, capabilities, signal: abort.signal,
                persist: (record) => this.automationStore!.writeRun(bindingHash, latest.policy, record) });
              if (started.record) await this.automationStore!.writeRun(bindingHash, latest.policy, started.record);
              return { ok: true, value: { repositoryLabel: binding.label, policy: latest.policy, run: started.run, capabilities: { ...capabilities, pushCredentialAvailable: binding.pushAvailable && !!publisher } } satisfies GitAutomationSnapshot };
            }
            const run = await resumeGitAutomationPush({ policy: latest.policy, record: latest.run, git: { load: () => service.load(), fingerprint: (paths) => service.automationFingerprint(paths), review: (value) => service.review(value), apply: (token) => service.apply(token), cancel: async (token) => { service.cancel(token); }, commitMessage: (oid) => service.automationCommitMessage(oid) },
              publisher, pushAvailable: binding.pushAvailable, capabilities, signal: abort.signal, now: Date.now() });
            if (run.record) await this.automationStore!.writeRun(bindingHash, latest.policy, run.record);
            return { ok: true, value: { repositoryLabel: binding.label, policy: latest.policy, run: run.run, capabilities: { ...capabilities, pushCredentialAvailable: binding.pushAvailable && !!publisher } } satisfies GitAutomationSnapshot };
          } finally { this.automationAborts.delete(abort); }
        });
      }
      const operation = this.serializeAutomation(bindingHash, async (): Promise<GitResult> => {
        const latest = await this.automationStore!.read(bindingHash, loaded.status.branch ?? 'main');
        if (latest.corrupt) return { ok: true, value: { repositoryLabel: binding.label, policy: latest.policy, run: { state: 'blocked', code: 'automation-settings-corrupt', files: [], updatedAt: Date.now() }, capabilities: { stage: false, commit: false, push: false, pushCredentialAvailable: false } } satisfies GitAutomationSnapshot };
        const capabilities = this.directCapabilities(binding.project.root, binding.project.projectId, !!input.mountId), publisher = !input.mountId ? await this.automationPublisherFor?.(input.sessionId) : undefined;
        const git = { load: () => service.load(), fingerprint: (paths: readonly string[]) => service.automationFingerprint(paths), review: (value: Parameters<LocalGitVersions['review']>[0]) => service.review(value),
          apply: (token: string) => service.apply(token), cancel: async (token: string) => { service.cancel(token); }, commitMessage: (oid: string) => service.automationCommitMessage(oid) };
        let result: Awaited<ReturnType<typeof runGitAutomationBatch>>;
        if (latest.run?.state === 'push-pending' || latest.run?.state === 'blocked' && !!latest.run.commit) result = { run: { state: latest.run.state, code: latest.run.code, branch: latest.run.branch, files: latest.run.paths, commit: latest.run.commit, updatedAt: latest.run.updatedAt, diffs: latest.run.diffs }, record: latest.run };
        else {
          const abort = new AbortController(); this.automationAborts.add(abort);
          try { result = await runGitAutomationBatch({ bindingHash, policy: latest.policy, stored: latest.run, git, publisher, pushAvailable: binding.pushAvailable, capabilities,
            now: Date.now(), signal: abort.signal, persist: (record) => this.automationStore!.writeRun(bindingHash, latest.policy, record) }); }
          finally { this.automationAborts.delete(abort); }
        }
        if (result.record) await this.automationStore!.writeRun(bindingHash, latest.policy, result.record);
        return { ok: true, value: { repositoryLabel: binding.label, policy: latest.policy, run: result.run, capabilities: { ...capabilities, pushCredentialAvailable: binding.pushAvailable && !!publisher } } satisfies GitAutomationSnapshot };
      });
      return await operation;
    } catch (error) {
      const code = error instanceof GitAutomationError || error instanceof GitStatusError ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'automation-failed';
      const message = code === 'authorization-expired' ? 'La autorización de GitHub venció. No se ejecutó el commit ni se reintentó la publicación.' : `Automatización Git detenida (${code}); revisa permisos, destino, rama y estado del repositorio.`;
      return { ok: false, error: { code, message } };
    }
  }
  async handle(input: unknown): Promise<GitResult> {
    if (!validGitRequest(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Solicitud Git inválida.' } };
    if (input.action === 'automation-state' || input.action === 'automation-save' || input.action === 'automation-preview' || input.action === 'automation-resume') return this.automation(input);
    try {
      await this.current(input.sessionId);
      if (input.action === 'mounts') return { ok: true, value: await this.manager.listGitMounts(input.sessionId) };
      if (input.action === 'mount-capability') {
        if (!await this.manager.setMountCapability(input.sessionId, input.mountId, 'git', input.granted)) throw new GitStatusError('permission-denied');
        return { ok: true, value: { changed: true } };
      }
      const service = await this.serviceFor(input.sessionId, input.mountId);
      if (input.action === 'cancel') { service.cancel(input.token); return { ok: true, value: { cancelled: true } }; }
      if (input.action === 'load') return { ok: true, value: await service.load() };
      if (input.action === 'review') return { ok: true, value: await service.review(input.input) };
      if (input.action === 'apply') return { ok: true, value: await service.apply(input.token, input.hunkIds) };
      throw new GitStatusError('invalid-request');
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

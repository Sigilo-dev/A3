import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { LocalProjectManager, MediaConversionPrepared, MediaConversionSource } from '@a3/project-store';
import { AV_PROFILES, validAvRequest, type AvEngineInfo, type AvInspection, type AvJobView, type AvRequest, type AvResult, type AvSettings } from '../shared/av-conversion.js';
import { AvError, avHash, avLosses, checkAvCancelled } from './av-engine.js';

type Store = Pick<LocalProjectManager, 'authorizeAvConversion' | 'loadMediaConversionSource' | 'prepareMediaConversionOutput' | 'commitMediaConversionOutput' | 'discardMediaConversionOutput'>;
export interface AvRunner {
  status(): Promise<AvEngineInfo>;
  probe(bytes: Uint8Array, cwd: string, signal: AbortSignal): Promise<AvInspection>;
  convert(bytes: Uint8Array, settings: AvSettings, cwd: string, signal: AbortSignal, progress: (seconds: number) => void): Promise<Uint8Array>;
  verify(bytes: Uint8Array, settings: AvSettings, source: AvInspection, cwd: string, signal: AbortSignal): Promise<AvInspection>;
}
interface Job {
  sessionId: string; controller: AbortController; view: AvJobView; pending?: Promise<void>;
  source?: Omit<MediaConversionSource, 'bytes'>; folder?: string; prepared?: MediaConversionPrepared; outputHash?: string;
  provenance?: import('@a3/domain').JsonValue;
}
const missingEngine: AvEngineInfo = { available: false, profiles: [], message: 'Comprobando componente opcional…' };

/** Only host-created, bounded jobs enter this queue. No paths/arguments for child processes cross IPC. */
export class AvConversionJobs {
  #jobs = new Map<string, Job>();
  #tails: Promise<void>[];
  #nextSlot = 0;
  #disposed = false;
  #resetting: Promise<void> | undefined;
  readonly #root: string;
  constructor(private readonly store: Store, stagingRoot: string, private readonly engine: AvRunner, maxConcurrent = 1) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TypeError('Invalid AV concurrency limit');
    this.#root = resolve(stagingRoot); this.#tails = Array.from({ length: maxConcurrent }, () => Promise.resolve());
  }
  #schedule(job: Job, run: () => Promise<void>): void {
    // One AV process job at a time, independent of the two-image worker pool.
    const slot = this.#nextSlot++ % this.#tails.length;
    const pending = this.#tails[slot]!.then(async () => {
      try { checkAvCancelled(job.controller.signal); await run(); }
      catch (error) {
        let cleanupWarning = '';
        await this.#cleanup(job).catch(() => { cleanupWarning = ' Temporal local pendiente de limpieza; no se registra como salida.'; });
        job.view.state = job.controller.signal.aborted ? 'cancelled' : error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error';
        job.view.message = (error instanceof Error ? error.message : 'No se pudo completar la conversión.') + cleanupWarning;
        job.view.progress = null;
      }
    });
    job.pending = pending;
    this.#tails[slot] = pending.catch(() => undefined);
    void pending.finally(() => { if (job.pending === pending) job.pending = undefined; }).catch(() => undefined);
  }
  async #folder(job: Job): Promise<string> {
    if (!job.folder) { await mkdir(this.#root, { recursive: true }); job.folder = await mkdtemp(join(this.#root, 'job-')); }
    checkAvCancelled(job.controller.signal); return job.folder;
  }
  async #cleanup(job: Job): Promise<void> {
    if (job.prepared) { await this.store.discardMediaConversionOutput(job.sessionId, job.prepared.token); job.prepared = undefined; }
    if (job.folder) {
      if (dirname(resolve(job.folder)) !== this.#root) throw new Error('Unexpected AV staging cleanup target');
      await rm(job.folder, { recursive: true, force: true }); job.folder = undefined;
    }
  }
  async handle(value: unknown): Promise<AvResult> {
    try {
      if (this.#disposed || this.#resetting || !validAvRequest(value) || value.action === 'configure-engine') throw new AvError('INVALID_REQUEST', 'Solicitud multimedia inválida o cambio de sesión en curso.');
      const request = structuredClone(value);
      if (request.action === 'engine-status') return { ok: true, value: await this.engine.status() };
      if (request.action === 'inspect') {
        if (this.#jobs.has(request.jobId) || this.#jobs.size >= 16) throw new AvError('MEDIA_JOB_EXISTS', 'Cierra trabajos pendientes o usa un ID nuevo (máximo 16).');
        const job: Job = { sessionId: request.sessionId, controller: new AbortController(), view: { jobId: request.jobId,
          resourceId: request.resourceId, sourceName: 'Medio local', state: 'inspecting', progress: null, engine: missingEngine } };
        this.#jobs.set(request.jobId, job); this.#schedule(job, () => this.#inspect(job));
        return { ok: true, value: structuredClone(job.view) };
      }
      const job = this.#jobs.get(request.jobId);
      if (!job || job.sessionId !== request.sessionId) throw new AvError('STALE_SESSION', 'El trabajo no pertenece a esta sesión.');
      if (request.action === 'status') return { ok: true, value: structuredClone(job.view) };
      if (request.action === 'cancel') {
        if (job.view.state === 'saving') throw new AvError('MEDIA_ALREADY_COMMITTING', 'La transacción ya comenzó; espera su resultado.');
        job.controller.abort(); await job.pending; await this.#cleanup(job); this.#jobs.delete(request.jobId);
        if (job.view.state !== 'saved') { job.view.state = 'cancelled'; job.view.progress = null; job.view.message = 'Cancelado; el origen se conserva.'; }
        return { ok: true, value: structuredClone(job.view) };
      }
      if (job.pending) throw new AvError('MEDIA_JOB_BUSY', 'El trabajo está en curso.');
      if (request.action === 'save' && job.view.state === 'saved') return { ok: true, value: structuredClone(job.view) };
      if (request.action === 'convert') {
        if (!job.source || !job.view.source?.supported || !['inspected', 'staged', 'error', 'conflict'].includes(job.view.state)) throw new AvError('MEDIA_SOURCE_NOT_READY', 'Inspecciona un origen compatible primero.');
        job.view.state = 'queued'; job.view.progress = null; delete job.view.message;
        this.#schedule(job, () => this.#convert(job, request));
        return { ok: true, value: structuredClone(job.view) };
      }
      const pending = this.#save(job); job.pending = pending;
      try { await pending; } finally { job.pending = undefined; }
      return { ok: true, value: structuredClone(job.view) };
    } catch (error) { return { ok: false, error: { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'MEDIA_FAILED',
      message: error instanceof Error ? error.message : 'Falló la operación multimedia.', recovery: 'El origen se conserva. Revisa componente, permisos, bytes y destino; vuelve a inspeccionar si cambiaron.' } }; }
  }
  async #inspect(job: Job): Promise<void> {
    await this.store.authorizeAvConversion(job.sessionId); checkAvCancelled(job.controller.signal);
    const input = await this.store.loadMediaConversionSource(job.sessionId, job.view.resourceId);
    job.view.sourceName = input.name; job.view.engine = await this.engine.status();
    if (!job.view.engine.available) throw new AvError('ENGINE_UNAVAILABLE', job.view.engine.message);
    const { bytes, ...source } = input;
    job.view.source = await this.engine.probe(bytes, await this.#folder(job), job.controller.signal);
    checkAvCancelled(job.controller.signal); job.source = source;
    await this.#cleanup(job); job.view.state = 'inspected';
  }
  async #convert(job: Job, request: Extract<AvRequest, { action: 'convert' }>): Promise<void> {
    await this.#cleanup(job); delete job.view.output;
    await this.store.authorizeAvConversion(job.sessionId);
    const source = job.source!, input = await this.store.loadMediaConversionSource(job.sessionId, source.resourceId);
    if (input.sha256 !== source.sha256 || input.revision !== source.revision || input.descriptorHash !== source.descriptorHash) throw new AvError('REVISION_CONFLICT', 'El original cambió; vuelve a inspeccionarlo.');
    const profile = AV_PROFILES.find((profile) => profile.id === request.settings.profile)!;
    if (!request.destination.toLowerCase().endsWith('.' + profile.id) || profile.video && !job.view.source!.streams.some((stream) => stream.kind === 'video')) throw new AvError('INVALID_SETTINGS', 'El destino/perfil no corresponde con el medio inspeccionado.');
    const folder = await this.#folder(job), signal = job.controller.signal;
    job.view.state = 'converting'; job.view.engine = await this.engine.status();
    const bytes = await this.engine.convert(input.bytes, request.settings, folder, signal, (seconds) => {
      job.view.progress = job.view.source!.duration ? Math.max(0, Math.min(99, seconds / job.view.source!.duration * 100)) : null;
    });
    checkAvCancelled(signal); job.view.state = 'verifying'; job.view.progress = null;
    const verified = await this.engine.verify(bytes, request.settings, job.view.source!, folder, signal);
    checkAvCancelled(signal);
    await writeFile(join(folder, 'output.bin'), bytes, { flag: 'wx' }); job.outputHash = avHash(bytes);
    const losses = avLosses(job.view.source!, request.settings);
    job.provenance = { sourceResourceId: source.resourceId, sourceRevision: source.revision, sourceHash: source.sha256,
      sourceDescriptorHash: source.descriptorHash, engine: { version: job.view.engine.version ?? '', license: job.view.engine.license ?? '' }, settings: { ...request.settings }, losses };
    job.prepared = await this.store.prepareMediaConversionOutput(job.sessionId, source, bytes, request.destination, profile.mediaType, job.provenance);
    checkAvCancelled(signal); job.view.output = { ...verified, path: request.destination, mediaType: profile.mediaType, losses };
    job.view.state = 'staged'; job.view.progress = 100;
  }
  async #save(job: Job): Promise<void> {
    if (!job.folder || !job.prepared || !job.source || !job.provenance || !job.view.output || job.view.state !== 'staged') throw new AvError('MEDIA_OUTPUT_NOT_STAGED', 'Prepara una salida validada antes de confirmar.');
    checkAvCancelled(job.controller.signal); job.view.state = 'saving';
    try {
      const bytes = await readFile(join(job.folder, 'output.bin'));
      if (avHash(bytes) !== job.outputHash) throw new AvError('REVISION_CONFLICT', 'Cambió el temporal; prepara de nuevo.');
      await this.store.authorizeAvConversion(job.sessionId);
      await this.store.discardMediaConversionOutput(job.sessionId, job.prepared.token);
      const mediaType = AV_PROFILES.find((profile) => profile.mediaType === job.view.output!.mediaType)!.mediaType;
      job.prepared = await this.store.prepareMediaConversionOutput(job.sessionId, job.source, bytes, job.view.output.path, mediaType, job.provenance);
      const saved = await this.store.commitMediaConversionOutput(job.sessionId, job.prepared.token);
      job.view.state = 'saved'; job.view.outputResourceId = saved.resourceId; job.view.message = 'Recurso nuevo creado; el original se conserva.';
      await this.#cleanup(job).catch(() => { job.view.message += ' Temporal local pendiente de limpieza.'; });
    } catch (error) {
      job.view.state = error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error';
      job.view.message = error instanceof Error ? error.message : 'No se pudo confirmar la salida.';
    }
  }
  async cancelAll(): Promise<void> {
    if (this.#resetting) return this.#resetting;
    const jobs = [...this.#jobs.values()];
    this.#resetting = (async () => {
      for (const job of jobs) if (job.view.state !== 'saving') job.controller.abort();
      await Promise.allSettled(jobs.map(async (job) => { await job.pending; await this.#cleanup(job); }));
      this.#jobs.clear();
    })();
    try { await this.#resetting; } finally { this.#resetting = undefined; }
  }
  async dispose(): Promise<void> { this.#disposed = true; await this.cancelAll(); }
}

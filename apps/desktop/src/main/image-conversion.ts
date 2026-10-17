import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LocalProjectManager, MediaConversionPrepared, MediaConversionSource } from '@a3/project-store';
import type { ImageConversionRequest, ImageConversionResult, ImageConversionSettings, ImageConversionView, ImageEngineInfo, ImageInspection, ImageOutputInfo } from '../shared/image-conversion';

type WorkerRequest = { action: 'inspect'; bytes: Uint8Array } | { action: 'convert'; bytes: Uint8Array; settings: ImageConversionSettings };
type WorkerResult = { source: ImageInspection; engine: ImageEngineInfo } | { bytes: Uint8Array; info: ImageOutputInfo };
export type ImageWorkerRunner = (input: WorkerRequest, signal: AbortSignal) => Promise<WorkerResult>;
type ConversionStore = Pick<LocalProjectManager, 'loadMediaConversionSource' | 'prepareMediaConversionOutput' | 'commitMediaConversionOutput' | 'discardMediaConversionOutput'>;
interface Job {
  sessionId: string; resourceId: string; controller: AbortController; source?: Omit<MediaConversionSource, 'bytes'>;
  view?: ImageConversionView; pending?: Promise<unknown>; prepared?: MediaConversionPrepared; folder?: string; outputHash?: string;
  provenance?: import('@a3/domain').JsonValue;
}
class ImageJobError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const cancelled = (): ImageJobError => new ImageJobError('CANCELLED', 'Conversión cancelada; el original se conserva.');
function check(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

/** Fixed worker code receives raster buffers and declarative settings, never paths or executable source. */
export function runImageWorker(workerPath: string, timeoutMs = 30_000): ImageWorkerRunner {
  return (input, signal) => new Promise((accept, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const worker = new Worker(workerPath, { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error?: Error, result?: WorkerResult): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      // Wait for the native task/thread to stop before freeing its concurrency slot.
      const complete = (): void => { if (error) reject(error); else accept(result!); };
      void worker.terminate().then(complete, complete);
    };
    const abort = (): void => finish(cancelled());
    const timer = setTimeout(() => finish(new ImageJobError('IMAGE_TIMEOUT', 'El motor de imagen excedió el tiempo local de 30 segundos.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message) => message?.ok ? finish(undefined, message.result) : finish(new ImageJobError('IMAGE_ENGINE_ERROR', message?.message ?? 'El motor rechazó la imagen.')));
    worker.once('error', () => finish(new ImageJobError('ENGINE_UNAVAILABLE', 'No se pudo cargar el worker o el componente nativo de imagen fijado.')));
    worker.once('exit', () => { if (!settled) finish(new ImageJobError('IMAGE_ENGINE_EXIT', 'El motor terminó sin producir una salida validada.')); });
  });
}
export function validImageConversionRequest(value: unknown): value is ImageConversionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>, uuid = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(input.sessionId) || !uuid(input.jobId)) return false;
  const keys = input.action === 'inspect' ? ['action', 'sessionId', 'jobId', 'resourceId'] : input.action === 'convert' ?
    ['action', 'sessionId', 'jobId', 'settings', 'destination'] : ['action', 'sessionId', 'jobId'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) return false;
  if (input.action === 'inspect') return uuid(input.resourceId);
  if (input.action === 'convert') return typeof input.destination === 'string' && input.destination.length <= 255 && !!input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings);
  return input.action === 'save' || input.action === 'cancel';
}

/** Staging is app-local and ephemeral. Only the project writer can promote a new resource. */
export class ImageConversionJobs {
  #jobs = new Map<string, Job>();
  #running = 0;
  #disposed = false;
  readonly #stagingRoot: string;
  constructor(private readonly store: ConversionStore, stagingRoot: string, private readonly run: ImageWorkerRunner, private readonly maxConcurrent = 2) {
    this.#stagingRoot = resolve(stagingRoot);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TypeError('Invalid image concurrency limit');
  }
  async #engine(input: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    if (this.#running >= this.maxConcurrent) throw new ImageJobError('MEDIA_QUEUE_FULL', 'Ya hay dos trabajos de imagen en curso. Espera o cancela uno.');
    this.#running++; try { check(signal); return await this.run(input, signal); } finally { this.#running--; }
  }
  async #cleanup(job: Job): Promise<void> {
    if (job.prepared) { await this.store.discardMediaConversionOutput(job.sessionId, job.prepared.token); job.prepared = undefined; }
    const folder = job.folder;
    if (folder) {
      if (dirname(resolve(folder)) !== this.#stagingRoot) throw new Error('Unexpected image staging cleanup target');
      await rm(folder, { recursive: true, force: true }); job.folder = undefined;
    }
  }
  async handle(value: unknown): Promise<ImageConversionResult> {
    if (this.#disposed || !validImageConversionRequest(value)) return this.#failure(new ImageJobError('INVALID_REQUEST', 'Solicitud de conversión inválida o servicio cerrado.'));
    const request = structuredClone(value);
    try {
      if (request.action === 'inspect') {
        if (this.#jobs.has(request.jobId) || this.#jobs.size >= 16) throw new ImageJobError('MEDIA_JOB_EXISTS', 'Cierra una conversión pendiente o inicia un ID nuevo.');
        const job: Job = { sessionId: request.sessionId, resourceId: request.resourceId, controller: new AbortController() };
        this.#jobs.set(request.jobId, job);
        const pending = this.#inspect(request, job); job.pending = pending;
        try { return { ok: true, value: structuredClone(await pending) }; }
        catch (error) { this.#jobs.delete(request.jobId); throw error; }
        finally { job.pending = undefined; }
      }
      const job = this.#jobs.get(request.jobId);
      if (!job || job.sessionId !== request.sessionId) throw new ImageJobError('STALE_SESSION', 'La conversión no pertenece a esta sesión.');
      if (request.action === 'cancel') {
        if (job.view?.state === 'saving') throw new ImageJobError('MEDIA_ALREADY_COMMITTING', 'La confirmación transaccional ya comenzó; consulta su resultado.');
        if (job.view?.state === 'saved') { await this.#cleanup(job); this.#jobs.delete(request.jobId); return { ok: true, value: structuredClone(job.view) }; }
        job.controller.abort(); await job.pending?.catch(() => undefined); await this.#cleanup(job); this.#jobs.delete(request.jobId);
        if (!job.view) throw cancelled();
        return { ok: true, value: { ...job.view, state: 'cancelled', message: cancelled().message } };
      }
      if (job.pending) throw new ImageJobError('MEDIA_JOB_BUSY', 'Este trabajo ya está en curso.');
      if (job.view?.state === 'saved' && request.action === 'save') return { ok: true, value: structuredClone(job.view) };
      const pending = request.action === 'convert' ? this.#convert(request, job) : this.#save(job);
      job.pending = pending;
      try { return { ok: true, value: structuredClone(await pending) }; } finally { job.pending = undefined; }
    } catch (error) { return this.#failure(error); }
  }
  async #inspect(request: Extract<ImageConversionRequest, { action: 'inspect' }>, job: Job): Promise<ImageConversionView> {
    const input = await this.store.loadMediaConversionSource(request.sessionId, request.resourceId); check(job.controller.signal);
    const result = await this.#engine({ action: 'inspect', bytes: input.bytes }, job.controller.signal); check(job.controller.signal);
    if (!('source' in result)) throw new Error('Invalid image inspection result');
    const { bytes: _bytes, ...source } = input; job.source = source;
    job.view = { jobId: request.jobId, resourceId: request.resourceId, sourceName: source.name, state: 'inspected', ...result }; return job.view;
  }
  async #convert(request: Extract<ImageConversionRequest, { action: 'convert' }>, job: Job): Promise<ImageConversionView> {
    if (!job.source || !job.view || job.controller.signal.aborted) throw cancelled();
    if (job.view.state === 'saved') throw new ImageJobError('MEDIA_ALREADY_SAVED', 'Abre una nueva conversión para crear otra salida.');
    await this.#cleanup(job); job.view.state = 'converting'; delete job.view.output; delete job.view.message;
    try {
      const input = await this.store.loadMediaConversionSource(job.sessionId, job.resourceId); check(job.controller.signal);
      if (input.sha256 !== job.source.sha256 || input.revision !== job.source.revision || input.descriptorHash !== job.source.descriptorHash) {
        throw new ImageJobError('REVISION_CONFLICT', 'El original cambió después de inspeccionarlo. Reabre la conversión para revisar los bytes nuevos.');
      }
      const result = await this.#engine({ action: 'convert', bytes: input.bytes, settings: request.settings }, job.controller.signal); check(job.controller.signal);
      if (!('info' in result)) throw new Error('Invalid image conversion result');
      await mkdir(this.#stagingRoot, { recursive: true }); job.folder = await mkdtemp(join(this.#stagingRoot, 'job-')); check(job.controller.signal);
      await writeFile(join(job.folder, 'output.bin'), result.bytes, { flag: 'wx' }); job.outputHash = hash(result.bytes); check(job.controller.signal);
      job.view.output = { ...result.info, path: request.destination };
      job.provenance = { sourceResourceId: job.source.resourceId, sourceRevision: job.source.revision, sourceHash: job.source.sha256,
        sourceDescriptorHash: job.source.descriptorHash, engine: { ...job.view.engine }, settings: { ...request.settings }, losses: result.info.warnings };
      job.prepared = await this.store.prepareMediaConversionOutput(job.sessionId, job.source, result.bytes, request.destination,
        result.info.mediaType as 'image/png' | 'image/jpeg' | 'image/avif' | 'application/pdf', job.provenance);
      check(job.controller.signal); job.view.state = 'staged'; return job.view;
    } catch (error) {
      if (job.controller.signal.aborted) { await this.#cleanup(job); throw cancelled(); }
      job.view.state = error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error';
      job.view.message = error instanceof Error ? error.message : 'No se pudo preparar la salida.'; return job.view;
    }
  }
  async #save(job: Job): Promise<ImageConversionView> {
    if (!job.prepared || !job.folder || !job.source || !job.provenance || !job.view?.output || job.view.state !== 'staged') throw new ImageJobError('MEDIA_OUTPUT_NOT_STAGED', 'Prepara una salida válida antes de confirmarla.');
    check(job.controller.signal);
    const bytes = await readFile(join(job.folder, 'output.bin'));
    if (hash(bytes) !== job.outputHash) throw new ImageJobError('REVISION_CONFLICT', 'Cambió la salida temporal; vuelve a preparar la conversión.');
    job.view.state = 'saving';
    try {
      // Sibling outputs may have committed since the preview. Reprepare only this
      // new file against the accepted writer state, keeping source/hash/destination
      // preconditions. External edits still fail closed in the project service.
      await this.store.discardMediaConversionOutput(job.sessionId, job.prepared.token);
      job.prepared = await this.store.prepareMediaConversionOutput(job.sessionId, job.source, bytes, job.view.output.path,
        job.view.output.mediaType as 'image/png' | 'image/jpeg' | 'image/avif' | 'application/pdf', job.provenance);
      const saved = await this.store.commitMediaConversionOutput(job.sessionId, job.prepared.token);
      job.view.state = 'saved'; job.view.outputResourceId = saved.resourceId; job.view.message = 'Recurso nuevo registrado; el original se conserva.';
      await this.#cleanup(job).catch(() => { job.view!.message += ' El temporal local no pudo limpiarse; el recurso ya está confirmado.'; }); return job.view;
    } catch (error) {
      job.view.state = error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error';
      job.view.message = error instanceof Error ? error.message : 'No se pudo guardar la conversión.'; return job.view;
    }
  }
  #failure(error: unknown): ImageConversionResult {
    return { ok: false, error: { code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IMAGE_CONVERSION_FAILED',
      message: error instanceof Error ? error.message : 'No se pudo convertir la imagen.', recovery: 'El original se conserva. Revisa el formato real, destino y permisos o vuelve a inspeccionar.' } };
  }
  async cancelAll(): Promise<void> {
    for (const job of this.#jobs.values()) if (job.view?.state !== 'saving') job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map(async (job) => { await job.pending?.catch(() => undefined); await this.#cleanup(job); }));
    this.#jobs.clear();
  }
  async dispose(): Promise<void> { this.#disposed = true; await this.cancelAll(); }
}

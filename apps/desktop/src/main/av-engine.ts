import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AV_PROFILES, validAvSettings, type AvEngineInfo, type AvInspection, type AvProfileId, type AvSettings, type AvStream } from '../shared/av-conversion.js';

export const AV_ENGINE_VERSION = '8.0.1';
export const AV_HASHES = {
  ffmpeg: '74db6c184a03dba2bdfe23e1a1f41cf5a8385bc1de6a7a1b26db1dc541abef93',
  ffprobe: '55bb6c6289367ae2383efa86b26bf2596f8adb72ac747360eb13df162354161c'
} as const;
export const AV_BYTE_LIMIT = 32 * 1024 * 1024;
const formats = 'mov,matroska,webm,wav,mp3,flac';
const codecs = 'ffv1,pcm_s16le,h264,aac,mp3,mp3float,flac';
const unavailable = (message: string): AvEngineInfo => ({ available: false, message, profiles: [] });
export class AvError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export const avHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const checkAvCancelled = (signal: AbortSignal): void => { if (signal.aborted) throw new AvError('CANCELLED', 'Conversión cancelada; el origen se conserva.'); };
export interface AvProcessOptions { timeoutMs?: number; maxBytes?: number; onProgress?: (seconds: number) => void; }
export interface AvProcessResult { stdout: Uint8Array; stderr: string; }
const safeInputOptions = ['-protocol_whitelist', 'pipe', '-format_whitelist', formats, '-codec_whitelist', codecs, '-probesize', '8388608', '-analyzeduration', '5000000'];

/** Child has no project paths, shell, inherited credentials, or file/network media protocols. */
export async function spawnAvPipe(executable: string, args: string[], bytes: Uint8Array, cwd: string, signal: AbortSignal, options: AvProcessOptions = {}): Promise<AvProcessResult> {
  checkAvCancelled(signal);
  return new Promise((accept, reject) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const child = spawn(executable, args, { shell: false, windowsHide: true, cwd,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'), TEMP: cwd, TMP: cwd, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let total = 0, errors = '', progress = '', failure: AvError | undefined, finished = false;
    const terminate = (error: AvError): void => { failure ??= error; try { child.kill('SIGKILL'); } catch { /* Already closed. */ } };
    const abort = (): void => terminate(new AvError('CANCELLED', 'Conversión cancelada; el parcial no se registra.'));
    const timer = setTimeout(() => terminate(new AvError('AV_TIMEOUT', 'El proceso multimedia excedió su tiempo permitido.')), options.timeoutMs ?? 120_000);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { total += chunk.length;
      if (total > (options.maxBytes ?? AV_BYTE_LIMIT)) terminate(new AvError('AV_OUTPUT_LIMIT', 'La salida supera el límite de esta conversión; no se registra un parcial.'));
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.length + chunk.length > 128 * 1024) terminate(new AvError('AV_DIAGNOSTIC_LIMIT', 'El motor excedió el límite de diagnósticos.'));
      else errors += chunk.toString('utf8');
    });
    const progressStream = child.stdio[3];
    if (progressStream && 'on' in progressStream) progressStream.on('data', (chunk: Buffer) => {
      progress += chunk.toString('utf8');
      if (progress.length > 8192) progress = progress.slice(-4096);
      let newline: number;
      while ((newline = progress.indexOf('\n')) >= 0) { const line = progress.slice(0, newline).trim(); progress = progress.slice(newline + 1);
        const match = /^out_time_us=(\d+)$/.exec(line); if (match) options.onProgress?.(Number(match[1]) / 1_000_000);
      }
    });
    child.stdin.on('error', () => undefined); child.stdin.end(Buffer.from(bytes));
    const finish = (code: number | null): void => {
      if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new AvError('AV_PROCESS_FAILED', 'FFmpeg/ffprobe rechazó los bytes o el perfil; la salida no se ha confirmado.'));
      else accept({ stdout: Buffer.concat(output), stderr: errors });
    };
    child.once('error', () => { failure = new AvError('ENGINE_UNAVAILABLE', 'No se pudo iniciar el ejecutable multimedia verificado.'); });
    child.once('close', finish);
  });
}

export function avInputSignature(bytes: Uint8Array): boolean {
  if (!bytes.length || bytes.length > AV_BYTE_LIMIT) return false;
  const head = Buffer.from(bytes.subarray(0, 32)), text = head.toString('latin1');
  return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE' ||
    text.startsWith('fLaC') || text.startsWith('ID3') || text.slice(4, 8) === 'ftyp' || head[0] === 255 && (head[1]! & 0xe0) === 0xe0;
}
function numberOrUndefined(input: unknown): number | undefined {
  const value = typeof input === 'string' || typeof input === 'number' ? Number(input) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function parseAvProbe(json: Uint8Array, bytes: number): AvInspection {
  const raw = JSON.parse(Buffer.from(json).toString('utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.streams) || raw.streams.length > 16 || !raw.format || typeof raw.format.format_name !== 'string') throw new AvError('AV_PROBE_INVALID', 'Inspección multimedia inválida.');
  const warnings: string[] = [], streams: AvStream[] = raw.streams.map((stream: Record<string, unknown>, index: number) => {
    const parts = typeof stream.avg_frame_rate === 'string' ? stream.avg_frame_rate.split('/').map(Number) : [], fps = parts[1] ? parts[0]! / parts[1] : undefined;
    const rate = typeof stream.r_frame_rate === 'string' ? stream.r_frame_rate.split('/').map(Number) : [], nominalFps = rate[1] ? rate[0]! / rate[1] : undefined;
    const tags = stream.tags && typeof stream.tags === 'object' ? stream.tags as Record<string, unknown> : {};
    let duration = numberOrUndefined(stream.duration);
    if (duration === undefined && typeof tags.DURATION === 'string') { const match = /^(\d+):(\d+):([\d.]+)$/.exec(tags.DURATION); if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]); }
    return { index: typeof stream.index === 'number' ? stream.index : index,
      kind: ['video', 'audio', 'subtitle', 'data', 'attachment'].includes(String(stream.codec_type)) ? stream.codec_type as AvStream['kind'] : 'unknown',
      codec: typeof stream.codec_name === 'string' ? stream.codec_name : 'unknown',
      ...(numberOrUndefined(stream.width) ? { width: Number(stream.width) } : {}), ...(numberOrUndefined(stream.height) ? { height: Number(stream.height) } : {}),
      ...(fps && Number.isFinite(fps) ? { frameRate: fps } : {}), ...(numberOrUndefined(stream.channels) ? { channels: Number(stream.channels) } : {}),
      ...(nominalFps && Number.isFinite(nominalFps) ? { nominalFrameRate: nominalFps } : {}),
      ...(numberOrUndefined(stream.sample_rate) ? { sampleRate: Number(stream.sample_rate) } : {}), ...(typeof stream.pix_fmt === 'string' ? { pixelFormat: stream.pix_fmt } : {}),
      ...(numberOrUndefined(stream.bits_per_raw_sample) || numberOrUndefined(stream.bits_per_sample) ? { bitsPerSample: numberOrUndefined(stream.bits_per_raw_sample) || numberOrUndefined(stream.bits_per_sample) } : {}),
      ...(typeof stream.profile === 'string' ? { profile: stream.profile } : {}), ...(duration !== undefined ? { duration } : {}) };
  });
  const video = streams.filter((stream) => stream.kind === 'video'), audio = streams.filter((stream) => stream.kind === 'audio');
  const duration = numberOrUndefined(raw.format.duration) ?? (streams.some((stream) => stream.duration !== undefined) ? Math.max(...streams.map((stream) => stream.duration ?? 0)) : null);
  const supported = streams.length > 0 && streams.length <= 2 && video.length <= 1 && audio.length === 1 && streams.every((stream) =>
    stream.kind === 'video' ? ['ffv1', 'h264'].includes(stream.codec) && !!stream.width && stream.width <= 1920 && !!stream.height && stream.height <= 1080 &&
      !!stream.frameRate && stream.frameRate <= 60 : stream.kind === 'audio' && ['pcm_s16le', 'aac', 'mp3', 'flac'].includes(stream.codec) && !!stream.channels && stream.channels <= 2 &&
      !!stream.sampleRate && stream.sampleRate <= 48000) && (duration === null || duration > 0 && duration <= 600);
  if (!supported) warnings.push('La matriz requiere una pista de audio y, opcionalmente, un video H.264/FFV1, hasta 1080p/60 fps, audio mono/estéreo hasta 48 kHz, duración máxima conocida 10 minutos. No se convierten pistas múltiples, subtítulos ni adjuntos.');
  if (duration === null) warnings.push('La duración no está disponible por pipe: el progreso será indeterminado; se aplican los límites de tiempo y bytes.');
  return { container: raw.format.format_name, bytes, streams, duration, warnings, supported };
}
export function avLosses(source: AvInspection, settings: AvSettings): string[] {
  const profile = AV_PROFILES.find((profile) => profile.id === settings.profile)!, video = source.streams.find((stream) => stream.kind === 'video');
  return [...source.warnings, 'La salida elimina metadatos, capítulos y etiquetas. El original se conserva.',
    'El audio se normaliza a estéreo/48 kHz; FLAC usa muestras de 16 bits. Cambia la frecuencia, canales o profundidad cuando difieren de la fuente.',
    ...(profile.video ? ['Video H.264 Baseline YUV 4:2:0 de 8 bits: hay pérdida de imagen, color/HDR y transparencia. La salida usa 30 fps.'] : []),
    ...(video && !profile.video ? ['Se extrae solo el audio; la salida no contiene video.'] : []),
    ...(profile.video && video && (video.width !== settings.width || video.height !== settings.height) ? ['El cambio de dimensiones remuestrea y puede alterar la proporción.'] : []),
    ...(['mp4', 'mov', 'mp3'].includes(profile.id) ? ['El audio se recodifica con pérdida.'] : ['FLAC no recupera calidad que ya se perdió en MP3/AAC u otras fuentes.']),
    ...(['mp4', 'mov'].includes(profile.id) ? ['Se utiliza un contenedor fragmentado para producirlo por pipe; la compatibilidad con reproductores puede variar.'] : [])];
}
export function avConversionArgs(settings: AvSettings): string[] {
  const profile = AV_PROFILES.find((profile) => profile.id === settings.profile)!;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...safeInputOptions, '-err_detect', 'explode', '-i', 'pipe:0', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn'];
  if (profile.video) args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-threads:v', '1', '-preset', 'veryfast', '-profile:v', 'baseline', '-level:v', '4.2',
    '-crf', String(settings.crf), '-vf', `scale=${settings.width}:${settings.height},format=yuv420p`, '-r', '30');
  else args.push('-map', '0:a:0', '-vn');
  args.push('-c:a', ['mp4', 'mov'].includes(profile.id) ? 'aac' : profile.id === 'mp3' ? 'libmp3lame' : 'flac');
  if (['mp4', 'mov', 'mp3'].includes(profile.id)) args.push('-b:a', `${settings.audioKbps}k`);
  else args.push('-sample_fmt', 's16');
  if (profile.id === 'mp4' || profile.id === 'mov') args.push('-profile:a', 'aac_low');
  args.push('-ar', '48000', '-ac', '2', '-progress', 'pipe:3', '-nostats');
  if (profile.id === 'mp4' || profile.id === 'mov') args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', ...(profile.id === 'mp4' ? ['-brand', 'isom'] : []));
  if (profile.id === 'mp3') args.push('-write_xing', '0');
  args.push('-f', profile.id === 'mkv' ? 'matroska' : profile.id, 'pipe:1'); return args;
}

/** Optional local package. Project/renderer data never provides an executable path. */
export class AvEngine {
  #root: string | undefined;
  #profiles: AvProfileId[] = [];
  #verifiedConfiguration = false;
  constructor(private readonly stateRoot: string) {}
  async #binary(tool: 'ffmpeg' | 'ffprobe'): Promise<string> {
    if (process.platform !== 'win32' || process.arch !== 'x64' || !this.#root) throw new AvError('ENGINE_UNAVAILABLE', 'Selecciona la instalación opcional FFmpeg 8.0.1 Windows x64 verificada.');
    const path = join(this.#root, tool + '.exe'), stat = await lstat(path).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase() || stat.size > 256 * 1024 * 1024 || avHash(await readFile(path)) !== AV_HASHES[tool]) {
      throw new AvError('ENGINE_INTEGRITY', 'El artefacto FFmpeg/ffprobe no coincide con los hashes de la build aprobada; permanece deshabilitado.');
    }
    return path;
  }
  async #process(tool: 'ffmpeg' | 'ffprobe', args: string[], bytes: Uint8Array, cwd: string, signal: AbortSignal, options?: AvProcessOptions): Promise<AvProcessResult> {
    const executable = await this.#binary(tool); checkAvCancelled(signal); return spawnAvPipe(executable, args, bytes, cwd, signal, options);
  }
  async #checkInstallation(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true }); const folder = await mkdtemp(join(this.stateRoot, 'engine-check-'));
    try {
      const signal = new AbortController().signal, empty = new Uint8Array();
      const version = await this.#process('ffmpeg', ['-version'], empty, folder, signal, { timeoutMs: 5000, maxBytes: 256 * 1024 });
      const probeVersion = await this.#process('ffprobe', ['-version'], empty, folder, signal, { timeoutMs: 5000, maxBytes: 256 * 1024 });
      const license = await this.#process('ffmpeg', ['-L'], empty, folder, signal, { timeoutMs: 5000, maxBytes: 256 * 1024 });
      const encoders = await this.#process('ffmpeg', ['-hide_banner', '-encoders'], empty, folder, signal, { timeoutMs: 5000, maxBytes: 256 * 1024 });
      const build = Buffer.from(version.stdout).toString();
      if (!build.startsWith('ffmpeg version 8.0.1-full_build-www.gyan.dev') || !['--enable-gpl', '--enable-version3', '--enable-static'].every((flag) => build.includes(flag)) || build.includes('--enable-nonfree') || !Buffer.from(probeVersion.stdout).toString().startsWith('ffprobe version 8.0.1-full_build-www.gyan.dev') ||
          !/GNU General Public License.*version 3/s.test(Buffer.from(license.stdout).toString())) throw new AvError('ENGINE_VERSION', 'La versión/licencia no coincide con el perfil Gyan GPLv3 fijado.');
      const encoderText = Buffer.from(encoders.stdout).toString(), has = (encoder: string): boolean => new RegExp(`\\s${encoder}\\s`).test(encoderText);
      this.#profiles = AV_PROFILES.filter((profile) => profile.video ? has('libx264') && has(profile.id === 'mkv' ? 'flac' : 'aac') : has(profile.id === 'mp3' ? 'libmp3lame' : 'flac')).map((profile) => profile.id);
      this.#verifiedConfiguration = true;
    } finally { await this.#clean(folder); }
  }
  async configure(selectedRoot: string): Promise<AvEngineInfo> {
    const canonical = await realpath(resolve(selectedRoot)); this.#root = canonical; this.#verifiedConfiguration = false;
    try {
      await this.#binary('ffmpeg'); await this.#binary('ffprobe'); await this.#checkInstallation();
      await writeFile(join(this.stateRoot, 'engine.json'), JSON.stringify({ schemaVersion: 1, root: canonical, version: AV_ENGINE_VERSION }) + '\n'); return this.status();
    } catch (error) { this.#root = undefined; this.#profiles = []; throw error; }
  }
  async status(): Promise<AvEngineInfo> {
    try {
      if (!this.#root) {
        const input = JSON.parse(await readFile(join(this.stateRoot, 'engine.json'), 'utf8'));
        if (input.schemaVersion !== 1 || input.version !== AV_ENGINE_VERSION || typeof input.root !== 'string') return unavailable('La instalación opcional no está configurada.');
        this.#root = await realpath(input.root);
      }
      await this.#binary('ffmpeg'); await this.#binary('ffprobe');
      if (!this.#verifiedConfiguration) await this.#checkInstallation();
      return { available: this.#profiles.length > 0, version: AV_ENGINE_VERSION, license: 'GPL-3.0-or-later (Gyan full_build estática)',
        profiles: [...this.#profiles], message: 'Instalación local verificada. Perfil de medios por pipes; sin sandbox de sistema operativo.' };
    } catch { return unavailable('Componente requerido: selecciona FFmpeg + ffprobe 8.0.1 de la build Windows x64 con integridad aprobada.'); }
  }
  async #clean(folder: string): Promise<void> {
    if (dirname(resolve(folder)) !== resolve(this.stateRoot)) throw new Error('Unexpected AV engine cleanup target');
    await rm(folder, { recursive: true, force: true });
  }
  async probe(bytes: Uint8Array, cwd: string, signal: AbortSignal): Promise<AvInspection> {
    if (!avInputSignature(bytes)) throw new AvError('AV_INPUT_UNSUPPORTED', 'La firma no es un contenedor local admitido. No se procesan playlists, scripts, URLs ni documentos.');
    const result = await this.#process('ffprobe', ['-v', 'error', '-max_alloc', '67108864', ...safeInputOptions, '-show_streams', '-show_format', '-of', 'json', '-i', 'pipe:0'], bytes, cwd, signal, { timeoutMs: 15000, maxBytes: 512 * 1024 });
    if (result.stderr.trim()) throw new AvError('AV_PROBE_ERROR', 'La inspección detectó bytes incompletos o errores de decodificación.');
    return parseAvProbe(result.stdout, bytes.length);
  }
  async convert(bytes: Uint8Array, settings: AvSettings, cwd: string, signal: AbortSignal, onProgress: (seconds: number) => void): Promise<Uint8Array> {
    if (!validAvSettings(settings)) throw new AvError('INVALID_SETTINGS', 'Parámetros fuera de los perfiles admitidos.');
    if (!avInputSignature(bytes)) throw new AvError('AV_INPUT_UNSUPPORTED', 'Origen multimedia fuera de la matriz.');
    const status = await this.status(); if (!status.available || !status.profiles.includes(settings.profile)) throw new AvError('ENGINE_UNAVAILABLE', status.message);
    const result = await this.#process('ffmpeg', avConversionArgs(settings), bytes, cwd, signal, { onProgress });
    if (!result.stdout.length || result.stderr.trim()) throw new AvError('AV_ENCODING_FAILED', 'No se produjo una salida completa sin errores; no se registra el parcial.');
    return result.stdout;
  }
  async verify(bytes: Uint8Array, settings: AvSettings, source: AvInspection, cwd: string, signal: AbortSignal): Promise<AvInspection> {
    const result = await this.probe(bytes, cwd, signal), profile = AV_PROFILES.find((profile) => profile.id === settings.profile)!;
    const video = result.streams.filter((stream) => stream.kind === 'video'), audio = result.streams.filter((stream) => stream.kind === 'audio');
    const container = settings.profile === 'mkv' ? result.container.includes('matroska') : ['mov', 'mp4'].includes(settings.profile) ? result.container.includes('mov') : result.container === settings.profile;
    if (!container || !result.supported || result.streams.length !== (profile.video ? 2 : 1) || audio.length !== 1 || audio[0]!.codec !== (['mp4', 'mov'].includes(profile.id) ? 'aac' : profile.id === 'mp3' ? 'mp3' : 'flac') ||
      audio[0]!.sampleRate !== 48000 || audio[0]!.channels !== 2 || (audio[0]!.codec === 'flac' && audio[0]!.bitsPerSample !== 16) || (audio[0]!.codec === 'aac' && audio[0]!.profile !== 'LC') ||
      (profile.video ? video.length !== 1 || video[0]!.codec !== 'h264' || video[0]!.pixelFormat !== 'yuv420p' || !video[0]!.profile?.includes('Baseline') ||
        video[0]!.width !== settings.width || video[0]!.height !== settings.height || Math.abs((video[0]!.nominalFrameRate ?? 0) - 30) > 0.01 : video.length !== 0)) throw new AvError('AV_OUTPUT_PROFILE', 'Los códecs/contenedor/dimensiones reales no coinciden con el perfil solicitado.');
    if ((settings.profile === 'mp4' || settings.profile === 'mov') && Buffer.from(bytes.subarray(8, 12)).toString() !== (settings.profile === 'mp4' ? 'isom' : 'qt  ')) throw new AvError('AV_OUTPUT_PROFILE', 'La marca real MP4/MOV no coincide.');
    if (source.duration && result.duration && Math.abs(source.duration - result.duration) > 0.3) throw new AvError('AV_OUTPUT_DURATION', 'La duración de la salida no coincide; posible truncamiento.');
    const decoded = await this.#process('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-max_alloc', '67108864', '-threads', '1',
      ...safeInputOptions, '-err_detect', 'explode', '-i', 'pipe:0', '-map', '0', '-f', 'null', 'pipe:1'], bytes, cwd, signal, { maxBytes: 1024 });
    if (decoded.stderr.trim()) throw new AvError('AV_OUTPUT_DECODE', 'La salida no superó una decodificación completa.');
    return result;
  }
}

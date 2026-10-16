import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLANTUML_SOURCE_LIMIT } from '@a3/domain/plantuml-source';
import type { PlantUmlRenderInput } from '@a3/project-store';

export const PLANTUML_ARTIFACT_FILE = 'plantuml-mit-1.2026.8.jar';
export const PLANTUML_ARTIFACT_SHA256 = '3629c9cd017c7f73e6450396eea0040216c7e1eef8473ce33cc1aad469dab2f9';
export const PLANTUML_ENGINE_VERSION = '1.2026.8';
export const PLANTUML_MINIMUM_JAVA_MAJOR = 21;
export const PLANTUML_RENDER_TIMEOUT_MS = 12_000;
export const PLANTUML_MAX_SVG_BYTES = 8 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 24 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;
const MAX_INCLUDE_ROOTS = 16;
const MAX_INCLUDE_FILES = 32;
const MAX_INCLUDE_FILE_BYTES = 256 * 1024;
const MAX_INCLUDE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;

export type PlantUmlRenderOutcome =
  | { state: 'rendered'; svg: string; sourceHash: string; rendererVersion: string; javaVersion: string }
  | { state: 'invalid' | 'timeout' | 'unavailable' | 'too-large'; message: string; line?: number; sourceHash?: string };

export interface JavaRuntime { executable: string; version: string; major: number; }
interface ProcessResult { code: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean; tooLarge: boolean; error?: Error; }
interface RendererOptions {
  artifactPath: string;
  installDirectory: string;
  timeoutMs?: number;
  resolveJava?: () => Promise<JavaRuntime | undefined>;
  runProcess?: (input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number }) => Promise<ProcessResult>;
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function pathKey(value: string): string { return resolve(value).replaceAll('\\', '/').toLowerCase(); }
function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function environmentFor(executable: string, temp: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const path = [dirname(executable), join(systemRoot, 'System32')].join(';');
  return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path, TEMP: temp, TMP: temp, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' };
}

function spawnBounded(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { resolvePromise({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, tooLarge: false, error: error instanceof Error ? error : new Error('spawn failed') }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, finished = false, timedOut = false, tooLarge = false;
    const close = (code: number | null, error?: Error): void => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, tooLarge, ...(error ? { error } : {}) });
    };
    const killTree = (): void => {
      if (process.platform === 'win32' && child.pid) {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
        try { const taskkill = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); taskkill.unref(); } catch { /* Child kill below remains best effort. */ }
      }
      try { child.kill('SIGKILL'); } catch { /* Process may already have exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > PLANTUML_MAX_SVG_BYTES) { tooLarge = true; killTree(); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_MAX_BYTES) { tooLarge = true; killTree(); return; }
      stderr.push(Buffer.from(chunk));
    });
    child.once('error', (error) => close(null, error));
    child.once('close', (code) => close(code));
    child.stdin.once('error', () => undefined);
    child.stdin.end(input.stdin, 'utf8');
  });
}

function parseMajor(output: string): number | undefined {
  const match = output.match(/(?:openjdk|java)\s+(?:version\s+)?["']?(\d+)(?:\.\d+)?/i);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
}

async function capture(executable: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environmentFor(executable, process.env.TEMP ?? 'C:\\Windows\\Temp') }); }
    catch { resolvePromise(Buffer.alloc(0)); return; }
    const chunks: Buffer[] = []; let size = 0, done = false;
    const finish = (): void => { if (done) return; done = true; clearTimeout(timer); resolvePromise(Buffer.concat(chunks)); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } finish(); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } finish(); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.once('error', finish); child.once('close', finish); child.stdin.end();
  });
}

export async function resolveJavaRuntime(): Promise<JavaRuntime | undefined> {
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  if (process.env.PATH) for (const folder of process.env.PATH.split(';')) if (folder) candidates.push(join(folder.replace(/^"|"$/g, ''), 'java.exe'));
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  candidates.push(join(systemRoot, 'System32', 'java.exe'));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = pathKey(candidate); if (seen.has(key)) continue; seen.add(key);
    const statResult = await lstat(candidate).catch(() => undefined);
    if (!statResult?.isFile()) continue;
    const output = (await capture(candidate, ['-version'], 3_000)).toString('utf8');
    const major = parseMajor(output);
    if (major && major >= PLANTUML_MINIMUM_JAVA_MAJOR) return { executable: await realpath(candidate), version: output.trim().split(/\r?\n/)[0]?.replace(/^.*?version\s*/i, '').replaceAll('"', '') ?? String(major), major };
  }
  return undefined;
}

function diagnosticLine(text: string): number | undefined {
  const match = text.match(/(?:line(?:Number)?|ligne)\s*[:#=]?\s*(\d+)/i);
  const line = match ? Number(match[1]) : NaN;
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function diagnosticMessage(stderr: string, roots: readonly string[]): string {
  let message = stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^java\s+version/i.test(line) && !/^(?:protocolVersion|status|lineNumber)=/i.test(line)) ?? '';
  message = message.replace(/^label=/i, '');
  if (!message && /status=NO_DATA/i.test(stderr)) message = 'PlantUML no pudo leer el diagrama; revisa la sintaxis y que los includes estén bajo una raíz autorizada.';
  if (!message && /status=ERROR/i.test(stderr)) message = stderr.match(/label=([^\r\n]+)/i)?.[1] ?? 'PlantUML encontró un error en la fuente.';
  for (const root of roots) if (root) message = message.replaceAll(root, '[raíz autorizada]').replaceAll(root.replaceAll('\\', '/'), '[raíz autorizada]');
  return message.replace(/[\r\n\0]/g, ' ').slice(0, 500) || 'PlantUML rechazó la fuente; el original permanece intacto.';
}

class IncludeExpansionError extends Error {
  constructor(message: string, readonly sourceLine: number) { super(message); }
}

async function expandAuthorizedIncludes(source: string, initialDirectory: string, roots: readonly string[]): Promise<string> {
  let includeCount = 0, totalBytes = 0;
  const includedOnce = new Set<string>(), active = new Set<string>();
  const containsRoot = (candidate: string): boolean => roots.some((root) => contained(root, candidate));
  const expand = async (text: string, directory: string, depth: number): Promise<string> => {
    if (depth > MAX_INCLUDE_DEPTH) throw new IncludeExpansionError(`La profundidad de includes supera ${MAX_INCLUDE_DEPTH}.`, 1);
    const output: string[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const lineNumber = index + 1;
      if (/^\s*!includeurl\b/i.test(line) || /%(?:load_json|file_exists)\s*\(/i.test(line)) {
        throw new IncludeExpansionError('Los includes remotos y las cargas de archivos/URLs están deshabilitados.', lineNumber);
      }
      const directive = line.match(/^\s*!(include(?:_once)?|include\w*)\s+(.+?)\s*$/i);
      if (!directive) { output.push(line); continue; }
      const kind = directive[1]!.toLowerCase(), rawTarget = directive[2]!.trim();
      if (!['include', 'include_once', 'include_many'].includes(kind)) throw new IncludeExpansionError('Esta variante de include no está permitida por el perfil local.', lineNumber);
      includeCount += 1;
      if (includeCount > MAX_INCLUDE_FILES) throw new IncludeExpansionError(`El límite de ${MAX_INCLUDE_FILES} includes fue alcanzado.`, lineNumber);
      if (rawTarget.startsWith('<') && rawTarget.endsWith('>') && rawTarget.length > 2) { output.push(line); continue; }
      const quoted = rawTarget.match(/^(?:"([^"]+)"|'([^']+)')$/);
      const target = quoted ? quoted[1] ?? quoted[2]! : rawTarget;
      if (!target || /[%$;\r\n\0]/.test(target) || target.includes('!')) throw new IncludeExpansionError('El include debe usar una ruta local literal; expresiones dinámicas se deshabilitaron.', lineNumber);
      if (/^(?:https?:|file:|\\\\)/i.test(target)) throw new IncludeExpansionError('Los includes remotos o UNC están deshabilitados.', lineNumber);
      const candidates = isAbsolute(target) ? [resolve(target)] : [resolve(directory, target), ...roots.map((root) => resolve(root, target))];
      let canonical = '';
      for (const candidate of [...new Set(candidates)]) {
        const resolved = await realpath(candidate).catch(() => '');
        if (!resolved) continue;
        if (!containsRoot(resolved)) throw new IncludeExpansionError('El include apunta fuera de las raíces locales autorizadas.', lineNumber);
        canonical = resolved; break;
      }
      if (!canonical) throw new IncludeExpansionError('El archivo incluido no existe dentro de una raíz autorizada.', lineNumber);
      const key = pathKey(canonical);
      if (kind === 'include_once' && includedOnce.has(key)) throw new IncludeExpansionError('El mismo archivo se repitió con !include_once.', lineNumber);
      if (kind === 'include' && includedOnce.has(key)) { output.push(''); continue; }
      if (active.has(key)) throw new IncludeExpansionError('Se detectó un ciclo de includes locales.', lineNumber);
      const before = await stat(canonical).catch(() => undefined);
      if (!before?.isFile() || before.size > MAX_INCLUDE_FILE_BYTES) throw new IncludeExpansionError(`Cada include debe ser un archivo de hasta ${MAX_INCLUDE_FILE_BYTES} bytes.`, lineNumber);
      const handle = await open(canonical, 'r').catch(() => undefined);
      if (!handle) throw new IncludeExpansionError('No se pudo abrir el include local autorizado.', lineNumber);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new IncludeExpansionError('El archivo incluido cambió durante la validación.', lineNumber);
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size) {
          throw new IncludeExpansionError('El archivo incluido cambió mientras se leía; no se inició el renderer.', lineNumber);
        }
      } finally { await handle.close().catch(() => undefined); }
      totalBytes += bytes.length;
      if (totalBytes > MAX_INCLUDE_TOTAL_BYTES) throw new IncludeExpansionError(`Los archivos incluidos superan el límite total de ${MAX_INCLUDE_TOTAL_BYTES} bytes.`, lineNumber);
      let included: string;
      try { included = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new IncludeExpansionError('Un archivo incluido no es UTF-8 válido.', lineNumber); }
      includedOnce.add(key);
      active.add(key);
      try { output.push(await expand(included, dirname(canonical), depth + 1)); }
      finally { active.delete(key); }
    }
    return output.join('\n');
  };
  return expand(source, initialDirectory, 0);
}

export class PlantUmlRenderer {
  #installedJar?: Promise<string | undefined>;
  #java?: Promise<JavaRuntime | undefined>;
  readonly timeoutMs: number;
  constructor(private readonly options: RendererOptions) { this.timeoutMs = options.timeoutMs ?? PLANTUML_RENDER_TIMEOUT_MS; }

  async #engine(): Promise<string | undefined> {
    if (this.#installedJar) return this.#installedJar;
    this.#installedJar = (async () => {
      const destinationDirectory = resolve(this.options.installDirectory);
      await mkdir(destinationDirectory, { recursive: true });
      const destination = join(destinationDirectory, PLANTUML_ARTIFACT_FILE);
      const verify = async (path: string): Promise<boolean> => {
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile() || info.size <= 0 || info.size > ARTIFACT_MAX_BYTES) return false;
        return hash(await readFile(path)) === PLANTUML_ARTIFACT_SHA256;
      };
      if (await verify(destination)) return destination;
      const source = resolve(this.options.artifactPath);
      if (!await verify(source)) return undefined;
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        if (!await verify(temporary)) return undefined;
        try { await rename(temporary, destination); }
        catch { if (await verify(destination)) return destination; throw new Error('PlantUML cache install failed.'); }
        return await verify(destination) ? destination : undefined;
      } catch { return undefined; }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
    })();
    return this.#installedJar;
  }

  async render(input: PlantUmlRenderInput): Promise<PlantUmlRenderOutcome> {
    const sourceHash = input.sourceHash;
    if (Buffer.byteLength(input.source, 'utf8') > PLANTUML_SOURCE_LIMIT) return { state: 'too-large', message: `La fuente supera el límite de ${PLANTUML_SOURCE_LIMIT} bytes; el archivo original no se modifica.`, sourceHash };
    const jar = await this.#engine();
    if (!jar) return { state: 'unavailable', message: `No está disponible el artefacto oficial PlantUML MIT ${PLANTUML_ENGINE_VERSION} íntegro; la fuente permanece intacta.`, sourceHash };
    const runtime = this.options.resolveJava ? await (this.#java ??= this.options.resolveJava()) : await (this.#java ??= resolveJavaRuntime());
    if (!runtime) return { state: 'unavailable', message: 'Se requiere Java 21 o posterior para renderizar. Instala Java en este equipo; la fuente permanece intacta.', sourceHash };
    if (!Array.isArray(input.includeRoots) || input.includeRoots.length < 1 || input.includeRoots.length > MAX_INCLUDE_ROOTS || input.includeRoots.some((path) => !isAbsolute(path) || path.includes(';') || /[\r\n\0]/.test(path))) {
      return { state: 'unavailable', message: 'No se pudo validar la lista acotada de raíces locales autorizadas; el render se canceló.', sourceHash };
    }
    const roots: string[] = [];
    for (const candidate of input.includeRoots) {
      const canonical = await realpath(candidate).catch(() => '');
      const rootStat = canonical ? await lstat(canonical).catch(() => undefined) : undefined;
      if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || pathKey(candidate) !== pathKey(canonical)) {
        return { state: 'unavailable', message: 'Una raíz de include falta o cambió de identidad; no se inició PlantUML.', sourceHash };
      }
      if (!roots.some((root) => pathKey(root) === pathKey(canonical))) roots.push(canonical);
    }
    const cwd = await realpath(input.workingDirectory).catch(() => '');
    const cwdStat = cwd ? await lstat(cwd).catch(() => undefined) : undefined;
    if (!cwdStat?.isDirectory() || cwdStat.isSymbolicLink() || pathKey(cwd) !== pathKey(input.workingDirectory) || !roots.some((root) => contained(root, cwd))) {
      return { state: 'unavailable', message: 'La carpeta de la fuente no pertenece a una raíz local autorizada; no se inició PlantUML.', sourceHash };
    }
    let renderSource: string;
    try { renderSource = await expandAuthorizedIncludes(input.source, cwd, roots); }
    catch (error) {
      if (error instanceof IncludeExpansionError) return { state: 'invalid', message: error.message, line: error.sourceLine, sourceHash };
      return { state: 'unavailable', message: 'No se pudieron validar los includes locales; el original permanece intacto.', sourceHash };
    }
    const tempRoot = resolve(this.options.installDirectory, 'render-tmp');
    await mkdir(tempRoot, { recursive: true });
    const temp = await mkdtemp(join(tempRoot, 'a3-plantuml-'));
    const args = [
      '-Xms32m', '-Xmx256m', '-XX:MaxMetaspaceSize=128m', '-XX:ActiveProcessorCount=2',
      '-Djava.awt.headless=true', `-Djava.io.tmpdir=${temp}`, '-DPLANTUML_LIMIT_SIZE=4096',
      '-DPLANTUML_SECURITY_PROFILE=ALLOWLIST',
      '-jar', jar, '-charset', 'UTF-8', '-tsvg', '-nometadata', '-failfast2', '-stdrpt:1', '-pipe'
    ];
    try {
      const run = this.options.runProcess ?? spawnBounded;
      const result = await run({ executable: runtime.executable, args, cwd: temp, env: environmentFor(runtime.executable, temp), stdin: renderSource, timeoutMs: this.timeoutMs });
      if (result.timedOut) return { state: 'timeout', message: `El render superó ${this.timeoutMs / 1000} segundos y se detuvo; el original permanece intacto.`, sourceHash };
      if (result.tooLarge || result.stdout.length > PLANTUML_MAX_SVG_BYTES) return { state: 'too-large', message: 'PlantUML excedió el límite de salida SVG; el original permanece intacto.', sourceHash };
      if (result.error) return { state: 'unavailable', message: 'No se pudo iniciar el runtime Java local; revisa su instalación. La fuente permanece intacta.', sourceHash };
      const stderr = result.stderr.toString('utf8');
      const svg = result.stdout.toString('utf8');
      const reportStatus = stderr.match(/^status=(\w+)/im)?.[1];
      if (result.code !== 0 || ['ERROR', 'NO_DATA'].includes(reportStatus ?? '') || /Welcome to PlantUML!/i.test(svg) || !/<svg\b/i.test(svg)) {
        const message = diagnosticMessage(stderr || svg, roots);
        return { state: 'invalid', message, ...(diagnosticLine(stderr || svg) ? { line: diagnosticLine(stderr || svg) } : {}), sourceHash };
      }
      return { state: 'rendered', svg, sourceHash, rendererVersion: PLANTUML_ENGINE_VERSION, javaVersion: runtime.version };
    } catch {
      return { state: 'unavailable', message: 'PlantUML no pudo completar el render local; la fuente permanece intacta.', sourceHash };
    } finally {
      const tempReal = await realpath(temp).catch(() => '');
      if (tempReal && contained(tempRoot, tempReal) && basename(tempReal).startsWith('a3-plantuml-')) await rm(tempReal, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

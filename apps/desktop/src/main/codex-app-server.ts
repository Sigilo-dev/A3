import { createReadStream } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type CodexProviderErrorCode =
  | 'BINARY_NOT_CONFIGURED' | 'BINARY_UNVERIFIED' | 'BINARY_MISSING' | 'BINARY_HASH_MISMATCH'
  | 'VERSION_CHECK_FAILED' | 'VERSION_MISMATCH' | 'SPAWN_FAILED' | 'HANDSHAKE_TIMEOUT'
  | 'HANDSHAKE_REJECTED' | 'UNEXPECTED_HANDSHAKE_MESSAGE' | 'MALFORMED_MESSAGE'
  | 'TRUNCATED_MESSAGE' | 'MESSAGE_TOO_LARGE' | 'PROCESS_EXITED' | 'START_CANCELLED'
  | 'PROCESS_STOP_TIMEOUT' | 'NOT_READY' | 'REQUEST_TIMEOUT' | 'REQUEST_REJECTED' | 'INVALID_RESPONSE';

const ERROR_MESSAGES: Record<CodexProviderErrorCode, string> = {
  BINARY_NOT_CONFIGURED: 'Codex app-server no está configurado en esta instalación.',
  BINARY_UNVERIFIED: 'El ejecutable de Codex no tiene una verificación válida.',
  BINARY_MISSING: 'No se encontró el ejecutable de Codex configurado.',
  BINARY_HASH_MISMATCH: 'El ejecutable de Codex no coincide con la huella aprobada.',
  VERSION_CHECK_FAILED: 'No se pudo comprobar la versión del ejecutable de Codex.',
  VERSION_MISMATCH: 'La versión del ejecutable de Codex no coincide con la aprobada.',
  SPAWN_FAILED: 'No se pudo iniciar el proceso local de Codex.',
  HANDSHAKE_TIMEOUT: 'Codex no respondió a la inicialización dentro del tiempo permitido.',
  HANDSHAKE_REJECTED: 'Codex rechazó la inicialización del cliente A3.',
  UNEXPECTED_HANDSHAKE_MESSAGE: 'Codex envió un mensaje no admitido durante la inicialización.',
  MALFORMED_MESSAGE: 'Codex envió una línea JSON malformada.',
  TRUNCATED_MESSAGE: 'Codex cerró el flujo con una línea JSON incompleta.',
  MESSAGE_TOO_LARGE: 'Codex envió un mensaje mayor que el límite permitido.',
  PROCESS_EXITED: 'El proceso de Codex terminó durante la inicialización.',
  START_CANCELLED: 'El inicio de Codex se canceló antes de completar la inicialización.',
  PROCESS_STOP_TIMEOUT: 'El proceso de Codex no terminó dentro del tiempo permitido.',
  NOT_READY: 'La conexión local de Codex no está inicializada.',
  REQUEST_TIMEOUT: 'La respuesta de Codex no llegó; el resultado queda incierto.',
  REQUEST_REJECTED: 'Codex rechazó la solicitud.',
  INVALID_RESPONSE: 'Codex envió una respuesta no válida.'
};

export class CodexProviderError extends Error {
  readonly code: CodexProviderErrorCode;
  constructor(code: CodexProviderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CodexProviderError';
    this.code = code;
  }
}

export interface CodexBinaryCandidate {
  executablePath: string;
  /** Semantic version reported by `codex --version`, without the `codex-cli` prefix. */
  expectedVersion: string;
  /** SHA-256 of the exact executable approved by the application distribution. */
  expectedSha256: string;
}

export interface CodexBinaryVerificationOptions {
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
}

const verifiedBinaries = new WeakSet<object>();

export interface VerifiedCodexBinary {
  readonly executablePath: string;
  readonly version: string;
  readonly sha256: string;
}

function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  env.PATH = [systemRoot ? join(systemRoot, 'System32') : undefined].filter((value): value is string => !!value).join(';');
  return env;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function readVersion(executablePath: string, spawnProcess: NonNullable<CodexBinaryVerificationOptions['spawnProcess']>, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let output = '';
    let settled = false;
    let child: ChildProcess;
    const finish = (error?: CodexProviderError, version?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise(version!);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* version probe already fails closed */ }
      finish(new CodexProviderError('VERSION_CHECK_FAILED'));
    }, timeoutMs);
    try {
      child = spawnProcess(executablePath, ['--version'], {
        cwd: dirname(executablePath), env: hostEnvironment(), shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { finish(new CodexProviderError('SPAWN_FAILED')); return; }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 512) finish(new CodexProviderError('VERSION_CHECK_FAILED'));
    });
    child.once('error', () => finish(new CodexProviderError('VERSION_CHECK_FAILED')));
    child.once('close', (code) => {
      if (code !== 0) { finish(new CodexProviderError('VERSION_CHECK_FAILED')); return; }
      const match = /^codex-cli\s+(\S+)\s*$/.exec(output.trim());
      if (!match) { finish(new CodexProviderError('VERSION_CHECK_FAILED')); return; }
      finish(undefined, match[1]);
    });
  });
}

/** Verifies an app-managed candidate before it may be passed to the process adapter. */
export async function verifyCodexBinary(candidate: CodexBinaryCandidate, options: CodexBinaryVerificationOptions = {}): Promise<VerifiedCodexBinary> {
  if (!candidate || typeof candidate.executablePath !== 'string' || !isAbsolute(candidate.executablePath) ||
      typeof candidate.expectedVersion !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(candidate.expectedVersion) ||
      typeof candidate.expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(candidate.expectedSha256)) {
    throw new CodexProviderError('BINARY_UNVERIFIED');
  }
  let executablePath: string;
  try {
    const resolved = resolve(candidate.executablePath);
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular executable');
    executablePath = await realpath(resolved);
  } catch { throw new CodexProviderError('BINARY_MISSING'); }
  const digest = await fileSha256(executablePath).catch(() => { throw new CodexProviderError('BINARY_MISSING'); });
  if (digest.toLowerCase() !== candidate.expectedSha256.toLowerCase()) throw new CodexProviderError('BINARY_HASH_MISMATCH');
  const version = await readVersion(executablePath, options.spawnProcess ?? nodeSpawn, options.timeoutMs ?? 5000);
  if (version !== candidate.expectedVersion) throw new CodexProviderError('VERSION_MISMATCH');
  const verified: VerifiedCodexBinary = Object.freeze({ executablePath, version, sha256: digest });
  verifiedBinaries.add(verified);
  return verified;
}

export interface A3AgentProviderSession {
  providerId: 'codex-app-server';
  protocolInitialized: true;
  artifactVersion: string;
}

/** The provider contract deliberately exposes lifecycle only; conversation/tool methods belong to later blocks. */
export interface A3AgentProvider {
  readonly providerId: 'codex-app-server';
  start(): Promise<A3AgentProviderSession>;
  stop(): Promise<void>;
}

export type CodexAppServerState = 'not-configured' | 'stopped' | 'starting' | 'ready' | 'stopping';

export type CodexSessionRequest =
  | { method: 'thread/resume'; params: { threadId: string; excludeTurns: true } }
  | { method: 'turn/interrupt'; params: { threadId: string; turnId: string } };
export type CodexSessionEvent =
  | { type: 'notification'; connectionId: string; sequence: number; message: Record<string, unknown> }
  | { type: 'disconnected'; code: CodexProviderErrorCode };

export interface CodexAppServerOptions {
  /** Application-owned userData directory, never a project path. */
  userDataDirectory: string;
  clientVersion: string;
  binary?: VerifiedCodexBinary;
  handshakeTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxMessageBytes?: number;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

class JsonLineReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private failed = false;
  constructor(private readonly maxBytes: number, private readonly onMessage: (message: unknown) => void, private readonly onError: (error: CodexProviderError) => void) {}
  push(chunk: Buffer): void {
    if (this.failed) return;
    try { this.pending += this.decoder.decode(chunk, { stream: true }); this.readLines(); }
    catch { this.fail('MALFORMED_MESSAGE'); }
  }
  finish(): void {
    if (this.failed) return;
    try { this.pending += this.decoder.decode(); this.readLines(); }
    catch { this.fail('MALFORMED_MESSAGE'); return; }
    if (this.pending.trim()) this.fail('TRUNCATED_MESSAGE');
  }
  private readLines(): void {
    if (Buffer.byteLength(this.pending) > this.maxBytes && !this.pending.includes('\n')) { this.fail('MESSAGE_TOO_LARGE'); return; }
    let newline: number;
    while (!this.failed && (newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxBytes) { this.fail('MESSAGE_TOO_LARGE'); return; }
      try { this.onMessage(JSON.parse(line) as unknown); }
      catch { this.fail('MALFORMED_MESSAGE'); return; }
    }
    if (Buffer.byteLength(this.pending) > this.maxBytes) this.fail('MESSAGE_TOO_LARGE');
  }
  private fail(code: CodexProviderErrorCode): void {
    this.failed = true;
    this.onError(new CodexProviderError(code));
  }
}

export class CodexAppServerProvider implements A3AgentProvider {
  readonly providerId = 'codex-app-server' as const;
  readonly profileDirectory: string;
  private readonly spawnProcess: NonNullable<CodexAppServerOptions['spawnProcess']>;
  private readonly handshakeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private stateValue: CodexAppServerState;
  private child?: ChildProcess;
  private starting?: Promise<A3AgentProviderSession>;
  private closeWaiters = new WeakSet<object>();
  private stopRequested = false;
  private readonly listeners = new Set<(event: CodexSessionEvent) => void>();
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: CodexProviderError): void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequestId = 1;
  private notificationSequence = 0;

  /** Host-only subscription: remote web contents and renderer IPC do not receive this stream. */
  subscribe(listener: (event: CodexSessionEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private publish(event: CodexSessionEvent): void {
    for (const listener of this.listeners) { try { listener(event); } catch { /* subscriber failure cannot corrupt framing */ } }
  }
  private disconnected(code: CodexProviderErrorCode): void {
    if (this.stateValue === 'ready') this.stateValue = 'stopping';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexProviderError(code)); }
    this.pending.clear(); this.publish({ type: 'disconnected', code });
  }
  request(request: CodexSessionRequest, timeoutMs = 10000): Promise<Record<string, unknown>> {
    if (this.stateValue !== 'ready' || !this.child?.stdin) return Promise.reject(new CodexProviderError('NOT_READY'));
    if (!request || !isObject(request.params) || Object.keys(request).sort().join(',') !== 'method,params') return Promise.reject(new CodexProviderError('INVALID_RESPONSE'));
    // No generic RPC escape hatch: only documented recovery/cancellation methods are exposed.
    const keys = request?.params && Object.keys(request.params).sort().join(',');
    if (!(request?.method === 'thread/resume' && request.params.excludeTurns === true && keys === 'excludeTurns,threadId' ||
          request?.method === 'turn/interrupt' && keys === 'threadId,turnId') ||
        !/^[\w-]{1,256}$/.test(request.params.threadId) ||
        request.method === 'turn/interrupt' && !/^[\w-]{1,256}$/.test(request.params.turnId)) return Promise.reject(new CodexProviderError('INVALID_RESPONSE'));
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexProviderError('REQUEST_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ ...request, id }) + '\n', (error?: Error | null) => {
        if (!error) return;
        const pending = this.pending.get(id); this.pending.delete(id);
        if (pending) { clearTimeout(timer); pending.reject(new CodexProviderError('PROCESS_EXITED')); }
      });
    });
  }
  private receiveProtocol(value: unknown, connectionId: string): void {
    if (!isObject(value) || typeof value.method === 'string' && 'id' in value) {
      this.disconnected('INVALID_RESPONSE'); void this.stop().catch(() => undefined); return;
    }
    if (typeof value.method === 'string' && !('id' in value)) {
      this.publish({ type: 'notification', connectionId, sequence: ++this.notificationSequence, message: value }); return;
    }
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || ('result' in value) === ('error' in value)) {
      this.disconnected('INVALID_RESPONSE'); void this.stop().catch(() => undefined); return;
    }
    const pending = typeof value.id === 'number' ? this.pending.get(value.id) : undefined;
    if (!pending) return; // late responses to timed-out requests cannot initiate another operation
    this.pending.delete(Number(value.id)); clearTimeout(pending.timer);
    if ('error' in value) pending.reject(new CodexProviderError('REQUEST_REJECTED'));
    else if (!isObject(value.result)) pending.reject(new CodexProviderError('INVALID_RESPONSE'));
    else pending.resolve(value.result);
  }

  constructor(private readonly options: CodexAppServerOptions) {
    if (!isAbsolute(options.userDataDirectory) || !options.clientVersion || options.clientVersion.length > 64) throw new CodexProviderError('BINARY_UNVERIFIED');
    this.profileDirectory = resolve(options.userDataDirectory, 'codex-app-server');
    this.spawnProcess = options.spawnProcess ?? nodeSpawn;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1500;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.stateValue = options.binary ? 'stopped' : 'not-configured';
  }

  get state(): CodexAppServerState { return this.stateValue; }

  start(): Promise<A3AgentProviderSession> {
    if (!this.options.binary) return Promise.reject(new CodexProviderError('BINARY_NOT_CONFIGURED'));
    if (!verifiedBinaries.has(this.options.binary)) return Promise.reject(new CodexProviderError('BINARY_UNVERIFIED'));
    if (this.stateValue === 'ready') return Promise.resolve({ providerId: this.providerId, protocolInitialized: true, artifactVersion: this.options.binary.version });
    if (this.starting) return this.starting;
    if (this.stateValue === 'stopping' || this.child) return Promise.reject(new CodexProviderError('NOT_READY'));
    this.stopRequested = false;
    const task = this.launch();
    this.starting = task;
    void task.finally(() => { if (this.starting === task) this.starting = undefined; }).catch(() => undefined);
    return task;
  }

  private async launch(): Promise<A3AgentProviderSession> {
    const binary = this.options.binary!;
    this.stateValue = 'starting';
    let child: ChildProcess;
    try {
      await mkdir(this.profileDirectory, { recursive: true });
      if (this.stopRequested) throw new CodexProviderError('START_CANCELLED');
      const currentInfo = await lstat(binary.executablePath).catch(() => { throw new CodexProviderError('BINARY_MISSING'); });
      if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || await realpath(binary.executablePath) !== binary.executablePath) {
        throw new CodexProviderError('BINARY_MISSING');
      }
      const currentHash = await fileSha256(binary.executablePath).catch(() => { throw new CodexProviderError('BINARY_MISSING'); });
      if (currentHash.toLowerCase() !== binary.sha256.toLowerCase()) throw new CodexProviderError('BINARY_HASH_MISMATCH');
      if (this.stopRequested) throw new CodexProviderError('START_CANCELLED');
      child = this.spawnProcess(binary.executablePath, ['app-server', '--listen', 'stdio://'], {
        cwd: this.profileDirectory,
        env: { ...hostEnvironment(), CODEX_HOME: this.profileDirectory },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      this.stateValue = 'stopped';
      throw error instanceof CodexProviderError ? error : new CodexProviderError('SPAWN_FAILED');
    }
    this.child = child;
    const connectionId = randomUUID(); this.notificationSequence = 0;

    let closed = false;
    child.once('close', () => {
      closed = true;
      this.closeWaiters.add(child);
      if (this.child === child) {
        this.child = undefined; this.disconnected('PROCESS_EXITED');
        if (this.stateValue === 'ready' || this.stateValue === 'stopping') this.stateValue = 'stopped';
      }
    });
    child.stderr?.on('data', () => { /* drain diagnostics without exposing provider text or secrets */ });

    try {
      const reader = new JsonLineReader(this.maxMessageBytes, (message) => receive(message), (error) => {
        finishHandshake(error); this.disconnected(error.code);
        void this.stop().catch(() => undefined);
      });
      child.stdout?.on('data', (chunk: Buffer) => reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.stdout?.once('end', () => reader.finish());

      let resolveHandshake!: (response: JsonObject) => void;
      let rejectHandshake!: (error: CodexProviderError) => void;
      let handshakeSettled = false;
      const handshake = new Promise<JsonObject>((resolvePromise, rejectPromise) => { resolveHandshake = resolvePromise; rejectHandshake = rejectPromise; });
      void handshake.catch(() => undefined); // a malformed frame may arrive before the stdin write callback
      const finishHandshake = (error?: CodexProviderError, value?: JsonObject): void => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        clearTimeout(timer);
        if (error) rejectHandshake(error); else resolveHandshake(value!);
      };
      const timer = setTimeout(() => finishHandshake(new CodexProviderError('HANDSHAKE_TIMEOUT')), this.handshakeTimeoutMs);
      const receive = (value: unknown): void => {
        if (handshakeSettled) { this.receiveProtocol(value, connectionId); return; }
        if (!isObject(value)) { finishHandshake(new CodexProviderError('UNEXPECTED_HANDSHAKE_MESSAGE')); return; }
        if (value.id !== 0 || ('method' in value) || (!('result' in value) && !('error' in value))) {
          finishHandshake(new CodexProviderError('UNEXPECTED_HANDSHAKE_MESSAGE')); return;
        }
        if ('error' in value) { finishHandshake(new CodexProviderError('HANDSHAKE_REJECTED')); return; }
        if (!isObject(value.result)) { finishHandshake(new CodexProviderError('UNEXPECTED_HANDSHAKE_MESSAGE')); return; }
        finishHandshake(undefined, value);
      };
      child.once('error', () => finishHandshake(new CodexProviderError('SPAWN_FAILED')));
      child.once('close', () => {
        if (!handshakeSettled) finishHandshake(new CodexProviderError(this.stopRequested ? 'START_CANCELLED' : 'PROCESS_EXITED'));
      });

      if (!child.stdin || child.stdin.destroyed) throw new CodexProviderError('SPAWN_FAILED');
      const initialize = JSON.stringify({ method: 'initialize', id: 0, params: {
        clientInfo: { name: 'a3', title: 'A3', version: this.options.clientVersion }
      } }) + '\n';
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.stdin!.write(initialize, (error?: Error | null) => error ? rejectPromise(new CodexProviderError('SPAWN_FAILED')) : resolvePromise());
      });
      await handshake;
      if (this.stopRequested || closed) throw new CodexProviderError('START_CANCELLED');
      const initialized = JSON.stringify({ method: 'initialized', params: {} }) + '\n';
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.stdin!.write(initialized, (error?: Error | null) => error ? rejectPromise(new CodexProviderError('SPAWN_FAILED')) : resolvePromise());
      });
      if (closed || this.stopRequested) throw new CodexProviderError('START_CANCELLED');
      this.stateValue = 'ready';
      return { providerId: this.providerId, protocolInitialized: true, artifactVersion: binary.version };
    } catch (error) {
      this.stateValue = 'stopping';
      try { await this.terminate(child); }
      catch { throw new CodexProviderError('PROCESS_STOP_TIMEOUT'); }
      if (this.child === child) this.child = undefined;
      this.stateValue = 'stopped';
      throw error instanceof CodexProviderError ? error : new CodexProviderError('SPAWN_FAILED');
    }
  }

  async stop(): Promise<void> {
    if (this.starting) {
      this.stopRequested = true;
      try { this.child?.stdin?.end(); } catch { /* bounded termination below */ }
      await this.starting.catch(() => undefined);
    }
    const child = this.child;
    if (!child) { this.stateValue = this.options.binary ? 'stopped' : 'not-configured'; return; }
    this.stateValue = 'stopping';
    try { child.stdin?.end(); } catch { /* try the bounded kill path */ }
    if (!await this.waitForClose(child, this.stopTimeoutMs)) {
      try { child.kill(); } catch { /* close timeout below reports failure */ }
      if (!await this.waitForClose(child, this.stopTimeoutMs)) {
        this.stateValue = 'stopping';
        throw new CodexProviderError('PROCESS_STOP_TIMEOUT');
      }
    }
    if (this.child === child) this.child = undefined;
    this.stateValue = this.options.binary ? 'stopped' : 'not-configured';
  }

  private async terminate(child: ChildProcess): Promise<void> {
    try { child.stdin?.end(); } catch { /* bounded kill path */ }
    if (await this.waitForClose(child, Math.min(this.stopTimeoutMs, 500))) return;
    try { child.kill(); } catch { /* bounded close path reports the result */ }
    if (!await this.waitForClose(child, Math.min(this.stopTimeoutMs, 500))) throw new CodexProviderError('PROCESS_STOP_TIMEOUT');
  }

  private waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.closeWaiters.has(child)) return Promise.resolve(true);
    return new Promise<boolean>((resolvePromise) => {
      let done = false;
      const finish = (closed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener('close', onClose);
        resolvePromise(closed);
      };
      const onClose = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('close', onClose);
    });
  }
}

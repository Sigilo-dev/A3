import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Actor } from '@a3/domain';
import type { ProjectCapabilityBroker } from './capabilities.js';

export const AGENT_PROCESS_LIMITS = Object.freeze({
  maxWallTimeMs: 120_000,
  maxCpuTimeMs: 120_000,
  maxOutputBytes: 1_048_576,
  maxMemoryMb: 512,
  maxProcesses: 8,
  maxArguments: 128,
  maxArgumentBytes: 64 * 1024
});

/** E0-C2 proved that a normal Node child escapes the logical project root on Windows. */
export const AGENT_PROCESS_ISOLATION_AVAILABLE = false;
export interface ApprovedExecutionRoot { id: string; path: string; identity: string; }
export interface AgentProcessIntent {
  executableId: string;
  arguments: readonly string[];
  rootId: string;
  cwdRelative: string;
  environment: Readonly<Record<string, string>>;
  wallTimeMs: number;
  cpuTimeMs: number;
  maxOutputBytes: number;
  maxMemoryMb: number;
  maxProcesses: number;
  network: false;
}
export type AgentProcessValidation =
  | { ok: true; cwd: string; environment: Readonly<Record<string, string>> }
  | { ok: false; code: 'INVALID_PROCESS_REQUEST' | 'PROCESS_ROOT_UNAVAILABLE' | 'PROCESS_PATH_OUTSIDE_ROOT' | 'PROCESS_REPARSE_POINT' | 'PROCESS_LIMIT_EXCEEDED' | 'PROCESS_NETWORK_NOT_ALLOWED' };
export type AgentProcessGateResult =
  | { ok: true; cwd: string; environment: Readonly<Record<string, string>>; isolation: 'verified' }
  | { ok: false; code: string; missingCapability?: 'process.run' };

const allowedEnvironment = new Set(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']);
const normalized = (path: string): string => resolve(path).replace(/[\\/]+$/, '').toLowerCase();
function identity(stat: { dev: bigint; ino: bigint; mode: bigint }): string {
  if (stat.ino === 0n) return '';
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}:${(stat.mode & 0o170000n).toString(16)}`;
}
function inside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

/** Host-only approval records bind a root to its current filesystem identity. */
export async function captureAgentExecutionRoot(id: string, path: string): Promise<ApprovedExecutionRoot> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || !isAbsolute(path)) throw new TypeError('PROCESS_ROOT_UNAVAILABLE');
  const selected = resolve(path), selectedStat = await lstat(selected, { bigint: true }), canonical = await realpath(selected), stat = await lstat(canonical, { bigint: true });
  if (selectedStat.isSymbolicLink() || normalized(canonical) !== normalized(selected) || stat.isSymbolicLink() || !stat.isDirectory() || normalized(await realpath(canonical)) !== normalized(canonical) || !identity(stat)) throw new TypeError('PROCESS_ROOT_UNAVAILABLE');
  return Object.freeze({ id, path: canonical, identity: identity(stat) });
}

/** Rechecks the approved root and every cwd segment immediately before a hypothetical launch. */
export async function validateAgentProcessIntent(intent: AgentProcessIntent, roots: readonly ApprovedExecutionRoot[]): Promise<AgentProcessValidation> {
  if (!intent || typeof intent !== 'object' || !Array.isArray(intent.arguments) || !intent.environment || typeof intent.environment !== 'object' ||
      Array.isArray(intent.environment) || typeof intent.executableId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(intent.executableId) ||
      typeof intent.rootId !== 'string' || typeof intent.cwdRelative !== 'string') return { ok: false, code: 'INVALID_PROCESS_REQUEST' };
  if (intent.network !== false) return { ok: false, code: 'PROCESS_NETWORK_NOT_ALLOWED' };
  const argsBytes = intent.arguments.reduce((size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : AGENT_PROCESS_LIMITS.maxArgumentBytes + 1), 0);
  const envEntries = Object.entries(intent.environment);
  if (intent.arguments.length > AGENT_PROCESS_LIMITS.maxArguments || argsBytes > AGENT_PROCESS_LIMITS.maxArgumentBytes ||
      intent.arguments.some((value) => typeof value !== 'string' || value.includes('\0')) ||
      !Number.isSafeInteger(intent.wallTimeMs) || intent.wallTimeMs < 1 || intent.wallTimeMs > AGENT_PROCESS_LIMITS.maxWallTimeMs ||
      !Number.isSafeInteger(intent.cpuTimeMs) || intent.cpuTimeMs < 1 || intent.cpuTimeMs > intent.wallTimeMs || intent.cpuTimeMs > AGENT_PROCESS_LIMITS.maxCpuTimeMs ||
      !Number.isSafeInteger(intent.maxOutputBytes) || intent.maxOutputBytes < 1 || intent.maxOutputBytes > AGENT_PROCESS_LIMITS.maxOutputBytes ||
      !Number.isSafeInteger(intent.maxMemoryMb) || intent.maxMemoryMb < 32 || intent.maxMemoryMb > AGENT_PROCESS_LIMITS.maxMemoryMb ||
      !Number.isSafeInteger(intent.maxProcesses) || intent.maxProcesses < 1 || intent.maxProcesses > AGENT_PROCESS_LIMITS.maxProcesses ||
      envEntries.length > allowedEnvironment.size || envEntries.some(([key, value]) => !allowedEnvironment.has(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) {
    return { ok: false, code: 'PROCESS_LIMIT_EXCEEDED' };
  }
  const root = roots.find((candidate) => candidate.id === intent.rootId);
  if (!root) return { ok: false, code: 'PROCESS_PATH_OUTSIDE_ROOT' };
  const parts = intent.cwdRelative.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (intent.cwdRelative.includes(':') || intent.cwdRelative.startsWith('/') || parts.some((part) => part === '..' || part.includes('\0'))) return { ok: false, code: 'PROCESS_PATH_OUTSIDE_ROOT' };
  try {
    const canonical = await realpath(root.path), rootStat = await lstat(canonical, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || identity(rootStat) !== root.identity || normalized(canonical) !== normalized(root.path)) return { ok: false, code: 'PROCESS_ROOT_UNAVAILABLE' };
    let current = canonical;
    for (const part of parts) {
      current = resolve(current, part);
      if (!inside(canonical, current)) return { ok: false, code: 'PROCESS_PATH_OUTSIDE_ROOT' };
      const stat = await lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || normalized(await realpath(current)) !== normalized(current)) return { ok: false, code: 'PROCESS_REPARSE_POINT' };
    }
    return { ok: true, cwd: current, environment: Object.freeze({ ...intent.environment }) };
  } catch { return { ok: false, code: 'PROCESS_ROOT_UNAVAILABLE' }; }
}

/** Every launch attempt is audited by the broker, then fails closed while no OS launcher is proven. */
export async function authorizeAgentProcess(input: {
  broker: ProjectCapabilityBroker; root: string; projectId: string; actor: Actor; intent: AgentProcessIntent; roots: readonly ApprovedExecutionRoot[];
}): Promise<AgentProcessGateResult> {
  const decision = await input.broker.authorizeCapabilities(input.root, input.actor, input.projectId, ['process.run'], 'agent.process.run', 'apply');
  if (!decision.allowed) return { ok: false, code: decision.reason, missingCapability: 'process.run' };
  const validation = await validateAgentProcessIntent(input.intent, input.roots);
  if (!validation.ok) return validation;
  if (!AGENT_PROCESS_ISOLATION_AVAILABLE) return { ok: false, code: 'PROCESS_ISOLATION_UNAVAILABLE', missingCapability: 'process.run' };
  return { ok: true, cwd: validation.cwd, environment: validation.environment, isolation: 'verified' };
}

/** Bounded collector for a verified launcher adapter; overflowing output is discarded and stopped. */
export class AgentProcessOutputLimit {
  private readonly parts: Buffer[] = [];
  private size = 0;
  private exceeded = false;
  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > AGENT_PROCESS_LIMITS.maxOutputBytes) throw new TypeError('PROCESS_LIMIT_EXCEEDED');
  }
  push(chunk: Uint8Array): boolean {
    if (this.exceeded) return false;
    if (!(chunk instanceof Uint8Array) || this.size + chunk.byteLength > this.maximumBytes) { this.exceeded = true; this.parts.length = 0; this.size = 0; return false; }
    this.parts.push(Buffer.from(chunk)); this.size += chunk.byteLength; return true;
  }
  get overflowed(): boolean { return this.exceeded; }
  result(): Buffer { return Buffer.concat(this.parts, this.size); }
}

export interface AgentProcessDeadline {
  signal: AbortSignal;
  readonly timedOut: boolean;
  cancel(): void;
  dispose(): void;
}
/** Deadline/cancel hook for an OS launcher; stopTree must terminate the whole job, not just its parent. */
export function createAgentProcessDeadline(wallTimeMs: number, stopTree: () => void | Promise<void>): AgentProcessDeadline {
  if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs < 1 || wallTimeMs > AGENT_PROCESS_LIMITS.maxWallTimeMs) throw new TypeError('PROCESS_LIMIT_EXCEEDED');
  const controller = new AbortController(); let expired = false, stopped = false;
  const stop = (): void => { if (stopped) return; stopped = true; void Promise.resolve().then(() => stopTree()).catch(() => undefined); };
  const timer = setTimeout(() => { expired = true; controller.abort(); stop(); }, wallTimeMs);
  return {
    signal: controller.signal,
    get timedOut() { return expired; },
    cancel() { clearTimeout(timer); controller.abort(); stop(); },
    dispose() { clearTimeout(timer); }
  };
}

/** Host-side cancellation hook; registered process adapters must terminate the whole OS job/tree. */
export class ActiveAgentProcessRegistry {
  private readonly active = new Map<string, { projectId: string; stopTree: () => void | Promise<void> }>();
  private readonly unsubscribe: () => void;
  constructor(broker: ProjectCapabilityBroker) {
    this.unsubscribe = broker.subscribeRevocations(({ projectId, capability }) => {
      if (capability !== 'process.run') return;
      for (const [id, task] of this.active) if (task.projectId === projectId) {
        this.active.delete(id); void Promise.resolve().then(() => task.stopTree()).catch(() => undefined);
      }
    });
  }
  track(id: string, projectId: string, stopTree: () => void | Promise<void>): () => void {
    if (!/^[a-z0-9_-]{1,128}$/i.test(id) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId) || this.active.has(id)) throw new TypeError('INVALID_ACTIVE_PROCESS');
    this.active.set(id, { projectId: projectId.toLowerCase(), stopTree });
    return () => { this.active.delete(id); };
  }
  close(): void { this.unsubscribe(); for (const task of this.active.values()) void Promise.resolve().then(() => task.stopTree()).catch(() => undefined); this.active.clear(); }
  get size(): number { return this.active.size; }
}

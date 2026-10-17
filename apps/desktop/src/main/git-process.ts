import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GIT_STATUS_EXCLUSIONS } from './git-status-policy.ts';

/** Verified system installation only; A3 neither downloads nor redistributes Git in E6-A1. */
export const GIT_STATUS_ENGINE = Object.freeze({
  version: '2.53.0.windows.1',
  bytes: 4344208,
  sha256: 'd09a1324132aa9da4b4c2b14242dcac893539a735fab288136b101156434a55a',
  license: 'GPL-2.0-only',
  source: 'https://github.com/git-for-windows/git/releases/tag/v2.53.0.windows.1',
  licenseSource: 'https://github.com/git/git/blob/v2.53.0/COPYING'
});
export class GitStatusError extends Error {
  constructor(readonly code: string) { super(`A3 Git: ${code}`); this.name = 'GitStatusError'; }
}
export interface VerifiedGitBinary { readonly path: string; readonly version: string; readonly sha256: string; }
export type GitInstallation = { state: 'available'; binary: VerifiedGitBinary } | { state: 'not-installed' | 'unverified-binary' };
const verified = new WeakSet<object>();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Deliberately does not inherit GIT_*, NODE_OPTIONS, proxies, SSH, credentials, or user config. */
export function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin';
  env.GIT_CEILING_DIRECTORIES = dirname(cwd);
  return env;
}

/** Private fixed-command runner, never an IPC method or a generic command API. */
async function run(executable: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new GitStatusError('cancelled');
  return new Promise((accept, reject) => {
    const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true, env: gitEnvironment(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    let total = 0, failure: GitStatusError | undefined;
    const chunks: Buffer[] = [];
    const stop = (code: string): void => { failure ??= new GitStatusError(code); child.kill(); };
    const abort = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), 10_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 8 * 1024 * 1024) stop('output-limit'); else chunks.push(chunk); });
    // Provider diagnostics/configuration may contain credentials. Never return or log stderr.
    child.stderr.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 8 * 1024 * 1024) stop('output-limit'); });
    child.once('error', (error: NodeJS.ErrnoException) => { failure ??= new GitStatusError(error.code === 'ENOENT' ? 'not-installed' : 'failed'); });
    child.once('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else if (code !== 0) reject(new GitStatusError('failed')); else accept(Buffer.concat(chunks));
    });
  });
}

export async function validateGitBinary(binary: VerifiedGitBinary): Promise<void> {
  if (!verified.has(binary)) throw new GitStatusError('unverified-binary');
  try {
    const stat = await lstat(binary.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== GIT_STATUS_ENGINE.bytes || !samePath(await realpath(binary.path), binary.path) || sha256(await readFile(binary.path)) !== binary.sha256) throw new GitStatusError('unverified-binary');
  } catch (error) { if (error instanceof GitStatusError) throw error; throw new GitStatusError('not-installed'); }
}

/** A path can only be supplied by host settings. No PATH search, project binary, or shell wrapper. */
export async function inspectGitInstallation(executablePath?: string): Promise<GitInstallation> {
  const path = executablePath ?? (process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'mingw64', 'bin', 'git.exe') : undefined);
  if (!path) return { state: 'not-installed' };
  if (!isAbsolute(path)) return { state: 'unverified-binary' };
  try {
    const canonical = await realpath(path), stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== GIT_STATUS_ENGINE.bytes || !samePath(canonical, resolve(path))) return { state: 'unverified-binary' };
    if (sha256(await readFile(path)) !== GIT_STATUS_ENGINE.sha256) return { state: 'unverified-binary' };
    const reported = (await run(canonical, ['--version'], dirname(canonical))).toString('utf8').trim();
    if (reported !== `git version ${GIT_STATUS_ENGINE.version}`) return { state: 'unverified-binary' };
    const binary = Object.freeze({ path: canonical, version: GIT_STATUS_ENGINE.version, sha256: GIT_STATUS_ENGINE.sha256 });
    verified.add(binary); return { state: 'available', binary };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { state: 'not-installed' };
    return { state: error instanceof GitStatusError && error.code === 'not-installed' ? 'not-installed' : 'unverified-binary' };
  }
}

/** The allowlist and every argument are owned by this module. No caller-supplied args/env. */
export async function runGitStatusCommand(binary: VerifiedGitBinary, cwd: string, operation: 'identity' | 'tracked' | 'status', signal?: AbortSignal): Promise<Buffer> {
  await validateGitBinary(binary);
  const safe = ['--no-pager', '--no-optional-locks', `--git-dir=${join(cwd, '.git')}`, `--work-tree=${cwd}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=', '-c', 'diff.external=', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  const command = operation === 'identity' ? ['rev-parse', '--show-toplevel', '--absolute-git-dir']
    : operation === 'tracked' ? ['ls-files', '-z', '--cached']
      : ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames', '--', '.', ...GIT_STATUS_EXCLUSIONS];
  return run(binary.path, [...safe, ...command], cwd, signal);
}

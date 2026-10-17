import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-github-ui-')), root = join(temp, 'project ñ'), binary = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/mingw64/bin/git.exe');
const git = (...args) => execFileSync(binary, ['-c', 'core.autocrlf=false', '-c', 'user.name=A3 Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true }); await writeFile(join(root, '.gitignore'), '.a3/local/\n');
  git('init', '-q', '-b', 'main'); git('add', '--', '.'); git('commit', '-q', '-m', 'test: baseline'); const head = git('rev-parse', 'HEAD');
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/github-publishing-smoke.cjs'), join(desktop, 'out/main/index.cjs'), join(temp, 'profile'), root], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Github smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_GITHUB_SMOKE=')); if (code || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); } });
  });
  assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('remote'), ''); assert.equal(git('status', '--porcelain'), '');
} finally {
  const target = resolve(temp); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('a3-github-ui-')) throw new Error('Invalid temp cleanup'); await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

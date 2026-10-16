import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-focus-smoke-')), profile = join(temp, 'profile'), root = join(temp, 'project');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
async function run(phase) {
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/focus-smoke.cjs'), phase, join(desktop, 'out/main/index.cjs'), profile, root], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Focus Electron timed out: ' + stdout + stderr)); }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; for (const line of chunk.toString().split(/\r?\n/)) if (line.startsWith('FOCUS_PHASE=')) console.log(line); }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => { clearTimeout(timeout); const line = stdout.split(/\r?\n/).find((v) => v.startsWith('A3_FOCUS_SMOKE=')); if (code !== 0 || !line) reject(new Error(stdout + stderr)); else { console.log(line); accept(); } });
  });
}
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  await run('prepare');
  const expected = JSON.parse(await readFile(join(profile, 'focus-expected.json'), 'utf8'));
  for (const path of [expected.missingPath, expected.locatedPath]) { const rel = relative(root, resolve(path)); if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw new Error('Relocation fixture escaped temporary project'); }
  await rename(expected.missingPath, expected.locatedPath);
  await run('restore');
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-focus-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

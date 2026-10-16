import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-navigation-smoke-')), root = join(temp, 'project'), profile = join(temp, 'profile');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/navigation-smoke.cjs'), join(desktop, 'out/main/index.cjs'), profile, root], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Navigation Electron timed out')); }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; for (const line of chunk.toString().split(/\r?\n/)) if (line.startsWith('NAVIGATION_PHASE=')) console.log(line); }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => { clearTimeout(timeout); const result = stdout.split(/\r?\n/).find((s) => s.startsWith('A3_NAVIGATION_SMOKE=')); if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); } });
  });
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-navigation-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

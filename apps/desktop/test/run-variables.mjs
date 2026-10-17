import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-variables-smoke-')), root = join(temp, 'project');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  const resource = JSON.parse(await readFile(join(root, '.a3/resources/00000000-0000-4000-8000-000000000004.json'), 'utf8'));
  const original = await readFile(join(root, resource.path));
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/variables-smoke.cjs'), join(desktop, 'out/main/index.cjs'), join(temp, 'profile'), root], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Variables Electron smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_VARIABLES_SMOKE='));
      if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); }
    });
  });
  assert.deepEqual(await readFile(join(root, resource.path)), original);
  const document = JSON.parse(await readFile(join(root, '.a3/variables/project.json'), 'utf8')); assert.equal(document.schemaVersion, '1.1.0');
  assert.equal(document.variables.some((v) => v.source?.value === 'temporary only'), false);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-variables-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-codex-auth-')), root = join(temp, 'project'), profile = join(temp, 'profile');
const env = { ...process.env }; for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ACCESS_TOKEN']) delete env[name];
async function portableBytes(directory, prefix = '') {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + item.name; if (path === '.a3/local') continue;
    if (item.isDirectory()) entries.push(...await portableBytes(join(directory, item.name), path + '/'));
    else entries.push([path, (await readFile(join(directory, item.name))).toString('base64')]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
async function launch(mode) {
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/codex-authorization-smoke.cjs'), join(desktop, 'out/main/index.cjs'), profile, root, mode], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('OAuth smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer); assert.equal((stdout + stderr).includes('synthetic-secret-'), false, 'No synthetic credentials in logs');
      const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_CODEX_AUTH_SMOKE='));
      if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); }
    });
  });
}
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true }); const before = await portableBytes(root);
  await launch('connect'); await launch('restore'); assert.deepEqual(await portableBytes(root), before);
} finally {
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith('a3-codex-auth-'));
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

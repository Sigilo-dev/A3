import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-extension-smoke-')), root = join(temp, 'project');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
async function originals(path, prefix = '') {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await originals(join(path, entry.name), name + '/'));
    else files.push([name, await readFile(join(path, entry.name))]);
  }
  return files;
}
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  const before = await originals(root);
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/extension-host-smoke.cjs'), join(desktop, 'out/main/index.cjs'), join(temp, 'profile'), root,
      join(desktop, '../../fixtures/e6/extensions/programmed-extension.json')], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Extension smoke timed out\n' + stdout + stderr)); }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer); const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_EXTENSION_HOST_SMOKE='));
      if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); }
    });
  });
  for (const [path, bytes] of before) assert.deepEqual(await readFile(join(root, path)), bytes, `project source changed: ${path}`);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-extension-smoke-')) throw new Error('Unsafe cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

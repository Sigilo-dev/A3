import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-manual-chat-')), root = join(temp, 'project'), second = join(temp, 'second');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
async function portableBytes(directory, prefix = '') {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + item.name; if (path === '.a3/local') continue;
    if (item.isDirectory()) entries.push(...await portableBytes(join(directory, item.name), path + '/'));
    else entries.push([path, (await readFile(join(directory, item.name))).toString('base64')]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true }); await cp(root, second, { recursive: true });
  const manifest = JSON.parse(await readFile(join(second, 'a3.project.json'), 'utf8')); manifest.projectId = '00000000-0000-4000-8000-000000009999'; await writeFile(join(second, 'a3.project.json'), JSON.stringify(manifest, null, 2) + '\n');
  const original = await portableBytes(root), other = await portableBytes(second);
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/manual-chat-smoke.cjs'), join(desktop, 'out/main/index.cjs'), join(temp, 'profile'), root, second], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Manual chat smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_MANUAL_CHAT_SMOKE='));
      if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); }
    });
  });
  assert.deepEqual(await portableBytes(root), original); assert.deepEqual(await portableBytes(second), other);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-manual-chat-')) throw new Error('Unsafe cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

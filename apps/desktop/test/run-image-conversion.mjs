import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const entry = process.argv.includes('--packaged') ? join(desktop, 'dist/win-unpacked/resources/app.asar/out/main/index.cjs') : join(desktop, 'out/main/index.cjs');
const temp = await mkdtemp(join(tmpdir(), 'a3-image-smoke-')), root = join(temp, 'project'), profile = join(temp, 'profile'), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  const resourceId = randomUUID(), sourceBytes = await readFile(join(desktop, '../../fixtures/e3/images/alpha.png'));
  await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets/source.jpg'), sourceBytes);
  await writeFile(join(root, '.a3/resources', resourceId + '.json'), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId, revision: 1,
    kind: 'project-file', path: 'assets/source.jpg', mediaType: 'image/jpeg', extensions: {} }, null, 2) + '\n');
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/image-conversion-smoke.cjs'), entry, profile, root,
      resourceId], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Image conversion Electron smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => { clearTimeout(timeout);
      const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_IMAGE_SMOKE='));
      if (code !== 0 || !result) reject(new Error(`${stdout}\n${stderr}`)); else { console.log(result); accept(); }
    });
  });
  assert.deepEqual(await readFile(join(root, 'assets/source.jpg')), sourceBytes);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-image-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

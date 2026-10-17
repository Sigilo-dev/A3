import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const entry = process.argv.includes('--packaged') ? join(desktop, 'dist/win-unpacked/resources/app.asar/out/main/index.cjs') : join(desktop, 'out/main/index.cjs');
const temp = await mkdtemp(join(tmpdir(), 'a3-av-smoke-')), root = join(temp, 'project'), profile = join(temp, 'profile'), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  const found = spawnSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
  assert.ok(found, 'The integration smoke needs the optional E0-D3 build.'); const engineRoot = dirname(await realpath(found));
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  const resourceId = randomUUID(), source = await readFile(join(desktop, '../../fixtures/e3/av/video.mkv'));
  await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets/source.bin'), source);
  await writeFile(join(root, '.a3/resources', resourceId + '.json'), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId, revision: 1,
    kind: 'project-file', path: 'assets/source.bin', mediaType: 'video/mp4', extensions: {} }, null, 2) + '\n');
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/av-conversion-smoke.cjs'), entry, profile, root, resourceId, engineRoot], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'AV Electron smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => { clearTimeout(timer);
      const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_AV_SMOKE='));
      if (code !== 0 || !result) reject(new Error(`${stdout}\n${stderr}`)); else { console.log(result); accept(); }
    });
  });
  assert.deepEqual(await readFile(join(root, 'assets/source.bin')), source);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-av-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

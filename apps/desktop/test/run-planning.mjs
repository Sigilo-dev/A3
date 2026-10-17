import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(desktop, 'package.json'));
const temp = await mkdtemp(join(tmpdir(), 'a3-planning-smoke-')), root = join(temp, 'project');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
try {
  await cp(join(desktop, '../../fixtures/e0/project'), root, { recursive: true });
  const fixtures = join(desktop, '../../fixtures/e4/planning'), records = JSON.parse(await readFile(join(fixtures, 'records.json'), 'utf8'));
  await mkdir(join(root, 'assets'), { recursive: true }); await cp(join(fixtures, 'planning-capture.svg'), join(root, 'assets/planning-capture.svg'));
  for (const record of records) await writeFile(join(root, '.a3', record.kind === 'entity' ? 'entities' : 'resources', record.value.id + '.json'), JSON.stringify(record.value, null, 2) + '\n');
  const original = await readFile(join(root, 'pages/readme.md'));
  await new Promise((accept, reject) => {
    const child = spawn(require('electron'), [join(desktop, 'test/planning-smoke.cjs'), join(desktop, 'out/main/index.cjs'), join(temp, 'profile'), root], { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr + 'Planning smoke timed out')); }, 90000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); const result = stdout.split(/\r?\n/).find((line) => line.startsWith('A3_PLANNING_SMOKE='));
      if (code !== 0 || !result) reject(new Error(stdout + stderr)); else { console.log(result); accept(); }
    });
  });
  assert.deepEqual(await readFile(join(root, 'pages/readme.md')), original);
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-planning-smoke-')) throw new Error('Unexpected cleanup target');
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

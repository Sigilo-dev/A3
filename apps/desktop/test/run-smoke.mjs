import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const electron = require('electron');
const packaged = process.argv.includes('--packaged');
const development = process.argv.includes('--development');
if (packaged && development) throw new Error('Select only one output mode.');
const source = packaged ? join(desktop, 'dist/win-unpacked/resources/app.asar/out') : join(desktop, 'out');
const temp = await mkdtemp(join(tmpdir(), 'a3-desktop-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let devServer;

async function startDevServer() {
  const cli = join(dirname(require.resolve('electron-vite')), 'cli.js');
  devServer = spawn(process.execPath, [cli, 'dev', '--rendererOnly'], {
    cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((accept, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Development server did not start.')), 20_000);
    devServer.stdout.on('data', (chunk) => {
      output += chunk;
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url) { clearTimeout(timeout); accept(url); }
    });
    devServer.stderr.on('data', (chunk) => { output += chunk; });
    devServer.once('error', (error) => { clearTimeout(timeout); reject(error); });
    devServer.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
  });
}

async function run(mode, output, expectedCode) {
  await new Promise((accept, reject) => {
    const child = spawn(electron, [join(desktop, 'test/smoke.cjs'), mode,
      join(output, 'main/index.cjs'), join(temp, mode), join(desktop, 'dist/smoke.png')],
    { cwd: desktop, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of chunk.toString().split(/\r?\n/)) if (line.startsWith('CANVAS_PHASE=')) console.log(`${mode}: ${line}`);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, mode === 'healthy' ? 180_000 : 60_000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`${mode}: Electron did not shut down. Last canvas phase: ${stdout.split(/\r?\n/).filter((line) => line.startsWith('CANVAS_PHASE=')).at(-1) ?? 'not started'}`));
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith('A3_SMOKE='));
      if (code !== expectedCode || !line) return reject(new Error(`${mode} exited ${code}: ${stdout}\n${stderr}`));
      const result = JSON.parse(line.slice('A3_SMOKE='.length));
      if (!result.passed) return reject(new Error(JSON.stringify(result)));
      console.log(JSON.stringify({ packagedOutput: packaged, development, ...result }));
      accept();
    });
  });
}

try {
  await mkdir(join(desktop, 'dist'), { recursive: true });
  if (development) env.ELECTRON_RENDERER_URL = await startDevServer();
  await run('healthy', source, 0);
  if (!packaged && !development) {
    for (const [mode, missing] of [['missing-renderer', 'renderer/index.html'], ['missing-preload', 'preload/index.cjs']]) {
      const fixture = join(temp, `${mode}-fixture`);
      await cp(source, fixture, { recursive: true });
      await rm(join(fixture, missing));
      await run(mode, fixture, 1);
    }
  }
} finally {
  if (devServer && devServer.exitCode === null) {
    await new Promise((accept) => { devServer.once('exit', accept); devServer.kill(); });
  }
  // Delete only the exact temporary profile tree allocated by this run.
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith('a3-desktop-smoke-')) {
    throw new Error('Unexpected temporary directory; cleanup refused.');
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

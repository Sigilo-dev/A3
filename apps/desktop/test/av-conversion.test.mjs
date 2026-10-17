import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LocalProjectManager } from '@a3/project-store';
import { fixtureHost, scratch } from '../../../packages/project-store/test/fixture.mjs';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.includes('/apps/desktop/src/')) return next(specifier.slice(0, -3) + '.ts', context);
  return next(specifier, context);
} });
const { AvEngine, AvError, AV_HASHES, avConversionArgs, avHash, avInputSignature, spawnAvPipe } = await import('../src/main/av-engine.ts');
const { AvConversionJobs } = await import('../src/main/av-conversion.ts');
const { AV_PROFILES, validAvRequest, validAvSettings } = await import('../src/shared/av-conversion.ts');
const fixtureRoot = fileURLToPath(new URL('../../../fixtures/e3/av/', import.meta.url));
const bytesOf = (name) => readFile(join(fixtureRoot, name));
const settings = (profile = 'mp4') => ({ profile, width: 160, height: 90, crf: 23, audioKbps: 128 });
const signal = () => new AbortController().signal;
const windows = { skip: process.platform !== 'win32' || process.arch !== 'x64' };
async function binaryRoot() {
  const found = spawnSync('where.exe', ['ffmpeg.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
  assert.ok(found, 'Native AV tests require the optional E0-D3 build; missing-engine tests remain independent.');
  const root = dirname(await realpath(found));
  for (const tool of ['ffmpeg', 'ffprobe']) assert.equal(avHash(await readFile(join(root, tool + '.exe'))), AV_HASHES[tool]);
  return root;
}
async function engineFor(t) {
  const { tempRoot } = await scratch(t), engine = new AvEngine(join(tempRoot, 'engine'));
  const info = await engine.configure(await binaryRoot()); assert.equal(info.available, true);
  return { engine, tempRoot };
}
async function settled(jobs, sessionId, jobId) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const result = await jobs.handle({ action: 'status', sessionId, jobId }); assert.equal(result.ok, true);
    if (!['inspecting', 'queued', 'converting', 'verifying', 'saving'].includes(result.value.state)) return result.value;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error('AV job timeout');
}

test('A3-040: optional/missing engine, fixed profiles and IPC reject executable paths/arguments', async (t) => {
  const { tempRoot } = await scratch(t), engine = new AvEngine(join(tempRoot, 'absent'));
  const unavailable = await engine.status(); assert.equal(unavailable.available, false); assert.deepEqual(unavailable.profiles, []);
  assert.deepEqual(AV_PROFILES.map((profile) => profile.id), ['mp4', 'mov', 'mkv', 'mp3', 'flac']);
  assert.equal(validAvSettings(settings()), true); assert.equal(validAvSettings({ ...settings(), args: ['-i', 'https://example.com'] }), false);
  assert.equal(validAvSettings({ ...settings(), width: 1919 }), false);
  assert.equal(validAvRequest({ action: 'configure-engine', path: 'C:/untrusted' }), false);
  assert.equal(validAvRequest({ action: 'convert', jobId: randomUUID(), sessionId: randomUUID(), settings: settings(), destination: '../out.mp4' }), false);
  for (const bytes of [Buffer.from('ffconcat version 1.0\nfile http://127.0.0.1/secret'), Buffer.from('#EXTM3U\nhttp://127.0.0.1/secret'), Buffer.from('<script/>')]) {
    assert.equal(avInputSignature(bytes), false); await assert.rejects(() => engine.probe(bytes, tempRoot, signal()), { code: 'AV_INPUT_UNSUPPORTED' });
  }
  const fake = join(tempRoot, 'fake'); await mkdir(fake); await writeFile(join(fake, 'ffmpeg.exe'), 'untrusted'); await writeFile(join(fake, 'ffprobe.exe'), 'untrusted');
  await assert.rejects(() => engine.configure(fake)); assert.equal((await engine.status()).available, false);
});

test('A3-040: real pinned Windows processes convert/verify all five profiles and preserve synthetic sources', windows, async (t) => {
  const { engine, tempRoot } = await engineFor(t), input = await bytesOf('video.mkv'), audio = await bytesOf('audio.wav'), before = avHash(input);
  const manifest = JSON.parse(await bytesOf('manifest.json'));
  for (const [name, fixture] of Object.entries(manifest.fixtures)) assert.equal(avHash(await bytesOf(name)), fixture.sha256);
  const source = await engine.probe(input, tempRoot, signal()); assert.equal(source.supported, true);
  assert.deepEqual(source.streams.map((stream) => stream.codec), ['ffv1', 'pcm_s16le']);
  for (const profile of AV_PROFILES) {
    const bytes = await engine.convert(input, settings(profile.id), tempRoot, signal(), () => {});
    const verified = await engine.verify(bytes, settings(profile.id), source, tempRoot, signal());
    assert.equal(verified.streams.find((stream) => stream.kind === 'audio').codec, ['mp4', 'mov'].includes(profile.id) ? 'aac' : profile.id === 'mp3' ? 'mp3' : 'flac');
    assert.equal(verified.streams.some((stream) => stream.kind === 'video'), profile.video);
    if (profile.id === 'mp4') await assert.rejects(() => engine.verify(bytes, settings('mov'), source, tempRoot, signal()), { code: 'AV_OUTPUT_PROFILE' });
    if (profile.id === 'flac') {
      const mp3 = await engine.convert(bytes, settings('mp3'), tempRoot, signal(), () => {});
      await engine.verify(mp3, settings('mp3'), await engine.probe(bytes, tempRoot, signal()), tempRoot, signal());
    }
  }
  const audioSource = await engine.probe(audio, tempRoot, signal()); assert.equal(audioSource.supported, true);
  for (const profile of ['mp3', 'flac']) await engine.verify(await engine.convert(audio, settings(profile), tempRoot, signal(), () => {}), settings(profile), audioSource, tempRoot, signal());
  assert.equal(avHash(input), before);
  await assert.rejects(() => engine.probe(input.subarray(0, 70), tempRoot, signal()));
  await assert.rejects(async () => engine.probe(await bytesOf('invalid.bin'), tempRoot, signal()));
  const root = await binaryRoot(), controller = new AbortController();
  const running = spawnAvPipe(join(root, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-f', 'null', 'pipe:1'], input, tempRoot, controller.signal);
  setTimeout(() => controller.abort(), 100); await assert.rejects(() => running, { code: 'CANCELLED' });
  await assert.rejects(() => spawnAvPipe(join(root, 'ffmpeg.exe'), ['-version'], new Uint8Array(), tempRoot, signal(), { timeoutMs: 1 }), { code: 'AV_TIMEOUT' });
  let requests = 0; const server = createServer((_request, response) => { requests++; response.end(audio); });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  try {
    const args = avConversionArgs(settings('mp3')), index = args.indexOf('pipe:0');
    for (const input of [`http://127.0.0.1:${server.address().port}/source.wav`, join(fixtureRoot, 'audio.wav')]) {
      const denied = [...args]; denied[index] = input;
      await assert.rejects(() => spawnAvPipe(join(root, 'ffmpeg.exe'), denied, new Uint8Array(), tempRoot, signal(), { timeoutMs: 2000 }), { code: 'AV_PROCESS_FAILED' });
    }
    assert.equal(requests, 0, 'the pipe-only input protocol list blocks HTTP before a request');
  } finally { await new Promise((accept) => server.close(accept)); }
});

test('A3-040: failed/unavailable engines and a source edited after inspection leave no output or new resource', windows, async (t) => {
  const { engine } = await engineFor(t), c = await project(t, engine);
  assert.equal((await settled(c.jobs, c.sessionId, c.jobId)).state, 'inspected');
  const source = await c.manager.loadMediaConversionSource(c.sessionId, c.resourceId);
  const descriptor = JSON.parse(await readFile(join(c.root, '.a3/resources', c.resourceId + '.json'), 'utf8'));
  await writeFile(join(c.root, descriptor.path), Buffer.from('external edit, keep these bytes'));
  await c.jobs.handle({ action: 'convert', sessionId: c.sessionId, jobId: c.jobId, settings: settings(), destination: 'assets/converted/stale.mp4' });
  const conflict = await settled(c.jobs, c.sessionId, c.jobId); assert.equal(conflict.state, 'conflict', conflict.message);
  assert.equal((await readFile(join(c.root, descriptor.path), 'utf8')), 'external edit, keep these bytes');
  await assert.rejects(() => readFile(join(c.root, 'assets/converted/stale.mp4')), { code: 'ENOENT' });
  assert.notEqual(source.sha256, avHash(await readFile(join(c.root, descriptor.path))));
  for (const available of [false, true]) {
    const runner = { status: async () => ({ available, profiles: available ? ['mp4'] : [], message: 'Componente requerido' }),
      probe: async () => { throw new AvError('AV_PROCESS_FAILED', 'El motor rechazó los bytes.'); },
      convert: async () => { throw new Error('Must not start conversion'); }, verify: async () => { throw new Error('Must not verify'); } };
    const fixture = await project(t, runner), failed = await settled(fixture.jobs, fixture.sessionId, fixture.jobId);
    assert.equal(failed.state, 'error'); assert.match(failed.message, available ? /rechazó/ : /Componente/);
    assert.equal((await fixture.manager.loadMediaGallery(fixture.sessionId)).items.length, 1);
  }
});

async function project(t, engine) {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'av-conversion');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  const active = (await manager.openFolder(root)).active;
  const canvas = await manager.loadCanvasWorkspace(active.sessionId, active.workspaces[0].id);
  const input = await bytesOf('video.mkv');
  const changed = await manager.createCanvasContentNode(active.sessionId, canvas.workspaceId, canvas.revision,
    { kind: 'video', title: 'Actual MKV', bytes: input, mediaType: 'video/mp4', position: { x: 0, y: 0 } });
  const resourceId = changed.entities.find((entity) => entity.title === 'Actual MKV').contentResourceId;
  const staging = join(tempRoot, 'staging'), jobs = new AvConversionJobs(manager, staging, engine), sessionId = active.sessionId, jobId = randomUUID();
  t.after(async () => { await jobs.dispose(); await manager.dispose(); });
  await jobs.handle({ action: 'inspect', sessionId, resourceId, jobId });
  return { root, tempRoot, host, manager, sessionId, resourceId, jobId, staging, jobs, input };
}

test('A3-040: staging/confirmation/reopen, original hash, collision, revocation and cancellation use the real writer', windows, async (t) => {
  const { engine } = await engineFor(t), c = await project(t, engine);
  const { jobs, manager, sessionId, jobId, root, resourceId } = c;
  assert.equal((await settled(jobs, sessionId, jobId)).state, 'inspected');
  const convert = () => jobs.handle({ action: 'convert', sessionId, jobId, settings: settings(), destination: 'assets/converted/result.mp4' });
  await convert(); const staged = await settled(jobs, sessionId, jobId); assert.equal(staged.state, 'staged', staged.message);
  await assert.rejects(() => readFile(join(root, staged.output.path)), { code: 'ENOENT' });
  assert.equal((await manager.loadMediaGallery(sessionId)).items.length, 1);
  const saved = await jobs.handle({ action: 'save', sessionId, jobId }); assert.equal(saved.value.state, 'saved', saved.value.message);
  assert.notEqual(saved.value.outputResourceId, resourceId);
  assert.equal((await jobs.handle({ action: 'save', sessionId, jobId })).value.outputResourceId, saved.value.outputResourceId);
  assert.equal((await manager.loadMediaConversionSource(sessionId, resourceId)).sha256, avHash(c.input));
  assert.equal((await readdir(c.staging)).length, 0);
  const second = randomUUID(); await jobs.handle({ action: 'inspect', sessionId, resourceId, jobId: second }); await settled(jobs, sessionId, second);
  await jobs.handle({ action: 'convert', sessionId, jobId: second, settings: settings(), destination: 'assets/converted/result.mp4' });
  const collision = await settled(jobs, sessionId, second); assert.ok(['conflict', 'error'].includes(collision.state), collision.message);
  await jobs.handle({ action: 'convert', sessionId, jobId: second, settings: settings('flac'), destination: 'assets/converted/cancel.flac' });
  const secondStage = await settled(jobs, sessionId, second); assert.equal(secondStage.state, 'staged', secondStage.message);
  await c.host.capabilities.revoke({ root, projectId: c.host.projectId, capability: 'media.convert' });
  const denied = await jobs.handle({ action: 'save', sessionId, jobId: second }); assert.equal(denied.value.state, 'error');
  await jobs.handle({ action: 'cancel', sessionId, jobId: second }); await assert.rejects(() => readFile(join(root, 'assets/converted/cancel.flac')), { code: 'ENOENT' });
  await manager.closeActive(sessionId); const reopened = (await manager.openFolder(root)).active;
  assert.equal((await manager.loadMediaGallery(reopened.sessionId)).items.length, 2);
});

test('A3-040: cancellation/failure of a queued or running process never publishes partial bytes; queue is serial', windows, async (t) => {
  let active = 0, max = 0, started, probes = 0;
  const start = new Promise((accept) => { started = accept; });
  const source = { container: 'matroska', bytes: 100, streams: [{ index: 0, kind: 'video', codec: 'ffv1', width: 160, height: 90 }, { index: 1, kind: 'audio', codec: 'pcm_s16le' }], duration: 1, warnings: [], supported: true };
  const runner = { status: async () => ({ available: true, profiles: AV_PROFILES.map((profile) => profile.id), message: 'fixture' }), probe: async () => { probes++; return source; },
    convert: async (_bytes, _settings, _cwd, signal) => { active++; max = Math.max(max, active); started(); try {
      await new Promise((_accept, reject) => { signal.addEventListener('abort', () => reject(new AvError('CANCELLED', 'cancelled')), { once: true }); });
    } finally { active--; } }, verify: async () => { throw new Error('A partial must not reach verification'); } };
  const c = await project(t, runner); await settled(c.jobs, c.sessionId, c.jobId);
  const request = { action: 'convert', sessionId: c.sessionId, jobId: c.jobId, settings: settings(), destination: 'assets/converted/partial.mp4' };
  await c.jobs.handle(request); await start;
  const secondId = randomUUID(); await c.jobs.handle({ action: 'inspect', sessionId: c.sessionId, resourceId: c.resourceId, jobId: secondId });
  const queuedCancellation = c.jobs.handle({ action: 'cancel', sessionId: c.sessionId, jobId: secondId });
  const cancelled = await c.jobs.handle({ action: 'cancel', sessionId: c.sessionId, jobId: c.jobId }); assert.equal(cancelled.value.state, 'cancelled');
  assert.equal((await queuedCancellation).value.state, 'cancelled'); assert.equal(probes, 1); assert.equal(max, 1);
  assert.equal((await c.manager.loadMediaGallery(c.sessionId)).items.length, 1); assert.deepEqual(await readdir(c.staging), []);
  await assert.rejects(() => readFile(join(c.root, request.destination)), { code: 'ENOENT' });
  const nextId = randomUUID(); await c.jobs.handle({ action: 'inspect', sessionId: c.sessionId, resourceId: c.resourceId, jobId: nextId });
  const closing = c.jobs.cancelAll();
  assert.equal((await c.jobs.handle({ action: 'inspect', sessionId: c.sessionId, resourceId: c.resourceId, jobId: randomUUID() })).ok, false, 'no new job may enter a closing session');
  await closing;
  assert.equal((await c.jobs.handle({ action: 'status', sessionId: c.sessionId, jobId: nextId })).ok, false);
});

test('A3-040: output verification failure never promotes a partial, and Consultar cannot launch the motor', windows, async (t) => {
  let calls = 0;
  const source = { container: 'matroska', bytes: 100, streams: [{ index: 0, kind: 'video', codec: 'ffv1' }, { index: 1, kind: 'audio', codec: 'pcm_s16le' }], duration: 1, warnings: [], supported: true };
  const runner = { status: async () => ({ available: true, profiles: ['mp4'], message: 'fixture' }), probe: async () => { calls++; return source; },
    convert: async () => Buffer.from('partial bytes'), verify: async () => { throw new AvError('AV_OUTPUT_PROFILE', 'Los códecs reales no coinciden.'); } };
  const c = await project(t, runner); await settled(c.jobs, c.sessionId, c.jobId);
  await c.jobs.handle({ action: 'convert', sessionId: c.sessionId, jobId: c.jobId, settings: settings(), destination: 'assets/converted/invalid.mp4' });
  const result = await settled(c.jobs, c.sessionId, c.jobId); assert.equal(result.state, 'error'); assert.match(result.message, /códecs/);
  assert.deepEqual(await readdir(c.staging), []); assert.equal((await c.manager.loadMediaGallery(c.sessionId)).items.length, 1);
  await c.host.capabilities.setProfile({ root: c.root, projectId: c.host.projectId, profile: 'consultar' });
  const jobId = randomUUID(); await c.jobs.handle({ action: 'inspect', sessionId: c.sessionId, resourceId: c.resourceId, jobId });
  const denied = await settled(c.jobs, c.sessionId, jobId); assert.equal(denied.state, 'error'); assert.match(denied.message, /media.convert/); assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { LocalProjectManager } from '@a3/project-store';
import { fixtureHost, scratch } from '../../../packages/project-store/test/fixture.mjs';
import { imageEngineInfo, inspectImage, validImageSettings } from '../src/main/image-codec.ts';
import { ImageConversionJobs, runImageWorker, validImageConversionRequest } from '../src/main/image-conversion.ts';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/e3/images/', import.meta.url));
const workerPath = fileURLToPath(new URL('../out/main/image-worker.cjs', import.meta.url));
const nativeWorker = runImageWorker(workerPath), windows = { skip: process.platform !== 'win32' || process.arch !== 'x64' };
const bytesOf = (name) => readFile(join(fixtureRoot, name)), sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const settingsFor = (source, format = 'png') => ({ format, width: source.width, height: source.height, quality: 85,
  transparency: 'preserve', background: '#ffffff', paper: 'A4', orientation: 'portrait', marginMm: 10 });
async function project(t, runner = nativeWorker) {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'image-conversion');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  const active = (await manager.openFolder(root)).active;
  let workspace = await manager.loadCanvasWorkspace(active.sessionId, active.workspaces[0].id);
  const sourceBytes = await bytesOf('alpha.png');
  workspace = await manager.createCanvasContentNode(active.sessionId, workspace.workspaceId, workspace.revision,
    { kind: 'image', title: 'Fixture PNG', position: { x: 0, y: 0 }, bytes: sourceBytes, mediaType: 'image/jpeg' });
  const resourceId = workspace.entities.find((entity) => entity.title === 'Fixture PNG').contentResourceId;
  const source = await manager.loadMediaConversionSource(active.sessionId, resourceId), stagingRoot = join(tempRoot, 'conversion-staging');
  const jobs = new ImageConversionJobs(manager, stagingRoot, runner);
  t.after(async () => { await jobs.dispose(); await manager.dispose(); });
  const jobId = randomUUID(), sessionId = active.sessionId;
  const inspected = await jobs.handle({ action: 'inspect', sessionId, resourceId, jobId }); assert.equal(inspected.ok, true);
  return { root, tempRoot, host, manager, active, source, stagingRoot, jobs, jobId, sessionId, resourceId, inspected: inspected.value };
}
async function stage(context, destination = 'assets/converted/result.png', format = 'png') {
  const result = await context.jobs.handle({ action: 'convert', sessionId: context.sessionId, jobId: context.jobId,
    settings: settingsFor(context.inspected.source, format), destination }); assert.equal(result.ok, true); return result.value;
}

test('A3-039: fixtures and Windows engine versions are pinned, real metadata overrides a misleading extension', windows, async () => {
  const manifest = JSON.parse(await bytesOf('manifest.json'));
  for (const [name, expected] of Object.entries(manifest.fixtures)) assert.equal(sha(await bytesOf(name)), expected.sha256);
  const engine = imageEngineInfo(); assert.equal(engine.sharp, '0.35.5'); assert.equal(engine.vips, '8.18.7');
  assert.deepEqual(engine.profiles.map((profile) => [profile.format, profile.available]), [['png', true], ['jpeg', true], ['avif', true], ['pdf', true]]);
  const png = await inspectImage(await bytesOf('alpha.png')); assert.equal(png.format, 'png'); assert.equal(png.alpha, true);
  const oriented = await inspectImage(await bytesOf('oriented.jpeg')); assert.equal(oriented.format, 'jpeg');
  assert.equal(oriented.width, 24); assert.equal(oriented.height, 32); assert.equal(oriented.hasMetadata, true);
  assert.equal((await inspectImage(await bytesOf('alpha.avif'))).format, 'avif');
  const animation = await inspectImage(await bytesOf('animated.gif')); assert.equal(animation.pages, 2); assert.equal(animation.supported, false);
  assert.match(animation.warnings.join(' '), /animación/);
  await assert.rejects(() => inspectImage(Buffer.from('<svg><script>throw 1</script></svg>')), /firma|Firma/);
  await assert.rejects(() => inspectImage(Buffer.from('%PDF-1.7')), /no se procesan/);
  await assert.rejects(async () => inspectImage(await bytesOf('invalid.bin')), /Firma/);
});

test('A3-039: the actual worker converts PNG/JPEG/AVIF to the validated PNG/JPEG/AVIF/PDF matrix', windows, async () => {
  for (const name of ['alpha.png', 'oriented.jpeg', 'alpha.avif']) {
    const input = await bytesOf(name), before = sha(input), source = await inspectImage(input);
    for (const format of ['png', 'jpeg', 'avif', 'pdf']) {
      const output = await nativeWorker({ action: 'convert', bytes: input, settings: settingsFor(source, format) }, new AbortController().signal);
      assert.ok('info' in output); assert.equal(output.info.format, format); assert.equal(output.info.bytes, output.bytes.length);
      if (format === 'pdf') {
        const pdf = await PDFDocument.load(output.bytes); assert.equal(pdf.getPageCount(), 1);
        assert.deepEqual(pdf.getPage(0).getSize(), { width: 595.28, height: 841.89 }); assert.equal(output.info.alpha, false);
      } else {
        const actual = await inspectImage(output.bytes); assert.equal(actual.format, format); assert.equal(actual.width, source.width); assert.equal(actual.height, source.height);
        assert.equal(actual.hasMetadata, false);
        assert.equal(actual.alpha, source.alpha && format !== 'jpeg');
        if (format === 'png' && name === 'alpha.png') {
          assert.deepEqual(await sharp(Buffer.from(output.bytes)).raw().toBuffer(), await sharp(input).raw().toBuffer(), 'PNG pixels/alpha remain identical for this sRGB/8-bit fixture');
        }
      }
      if (format === 'jpeg' && source.alpha) assert.match(output.info.warnings.join(' '), /transparencia/);
      if (format === 'avif' || format === 'jpeg') assert.match(output.info.warnings.join(' '), /pérdida/);
      assert.equal(sha(input), before);
    }
  }
  const source = await inspectImage(await bytesOf('alpha.png'));
  const pdf = await nativeWorker({ action: 'convert', bytes: await bytesOf('alpha.png'), settings: { ...settingsFor(source, 'pdf'), paper: 'A3', orientation: 'landscape' } }, new AbortController().signal);
  assert.deepEqual((await PDFDocument.load(pdf.bytes)).getPage(0).getSize(), { width: 1190.55, height: 841.89 });
});

test('invalid/truncated/animated input, bad settings, absent engine, timeout and native cancellation preserve source buffers', windows, async () => {
  const png = await bytesOf('alpha.png'), before = sha(png), source = await inspectImage(png), settings = settingsFor(source);
  for (const bytes of [await bytesOf('invalid.bin'), png.subarray(0, 24), await bytesOf('animated.gif')]) {
    await assert.rejects(() => nativeWorker({ action: 'convert', bytes, settings }, new AbortController().signal));
  }
  assert.equal(validImageSettings({ ...settings, width: 0 }), false); assert.equal(validImageSettings({ ...settings, command: 'run' }), false);
  assert.equal(validImageConversionRequest({ action: 'save', sessionId: randomUUID(), jobId: randomUUID(), path: 'C:/outside.png' }), false);
  await assert.rejects(() => runImageWorker(join(fixtureRoot, 'missing.cjs'))({ action: 'inspect', bytes: png }, new AbortController().signal), { code: 'ENGINE_UNAVAILABLE' });
  await assert.rejects(() => runImageWorker(workerPath, 1)({ action: 'inspect', bytes: png }, new AbortController().signal), { code: 'IMAGE_TIMEOUT' });
  const abort = new AbortController(), running = nativeWorker({ action: 'convert', bytes: png, settings }, abort.signal); abort.abort();
  await assert.rejects(() => running, { code: 'CANCELLED' }); assert.equal(sha(png), before);
});

test('project staging creates a new Resource only after confirmation, survives reopen and retains the original bytes', windows, async (t) => {
  const context = await project(t); const { jobs, manager, sessionId, jobId, root, source, stagingRoot } = context;
  assert.match(source.name, /\.bin$/); assert.equal(context.inspected.source.format, 'png', 'the generic extension and JPEG MIME do not override the actual PNG decoder');
  const staged = await stage(context, 'assets/converted/photo.jpg', 'jpeg'); assert.equal(staged.state, 'staged');
  await assert.rejects(() => readFile(join(root, staged.output.path)), { code: 'ENOENT' });
  assert.equal((await manager.loadMediaGallery(sessionId)).items.length, 1); assert.equal((await readdir(stagingRoot)).length, 1);
  const saved = await jobs.handle({ action: 'save', sessionId, jobId }); assert.equal(saved.value.state, 'saved');
  assert.notEqual(saved.value.outputResourceId, source.resourceId); assert.equal((await readdir(stagingRoot)).length, 0);
  assert.equal((await manager.loadMediaConversionSource(sessionId, source.resourceId)).sha256, source.sha256);
  const descriptorPath = join(root, '.a3/resources', saved.value.outputResourceId + '.json'), descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.equal(descriptor.extensions['a3.media.conversion'].sourceHash, source.sha256);
  assert.equal((await jobs.handle({ action: 'save', sessionId, jobId })).value.outputResourceId, saved.value.outputResourceId, 'repeated confirmation is idempotent for this host job');
  await manager.closeActive(sessionId); const reopened = (await manager.openFolder(root)).active;
  assert.equal((await manager.loadMediaGallery(reopened.sessionId)).items.length, 2);
});

test('cancelled staged output cleans only its private staging and creates neither file nor orphan Resource', windows, async (t) => {
  const context = await project(t); await stage(context);
  const result = await context.jobs.handle({ action: 'cancel', sessionId: context.sessionId, jobId: context.jobId }); assert.equal(result.value.state, 'cancelled');
  assert.deepEqual(await readdir(context.stagingRoot), []);
  await assert.rejects(() => readFile(join(context.root, 'assets/converted/result.png')), { code: 'ENOENT' });
  assert.equal((await context.manager.loadMediaGallery(context.sessionId)).items.length, 1);
  assert.equal((await context.manager.loadMediaConversionSource(context.sessionId, context.resourceId)).sha256, context.source.sha256);
});

test('a staged batch confirms independent outputs without treating an earlier sibling commit as an external edit', windows, async (t) => {
  const context = await project(t), secondId = randomUUID();
  const second = await context.jobs.handle({ action: 'inspect', sessionId: context.sessionId, jobId: secondId, resourceId: context.resourceId }); assert.equal(second.ok, true);
  const results = await Promise.all([
    stage(context, 'assets/converted/batch-a.png'),
    context.jobs.handle({ action: 'convert', sessionId: context.sessionId, jobId: secondId, settings: settingsFor(second.value.source, 'jpeg'), destination: 'assets/converted/batch-b.jpeg' })
  ]);
  assert.equal(results[0].state, 'staged'); assert.equal(results[1].value.state, 'staged');
  for (const jobId of [context.jobId, secondId]) assert.equal((await context.jobs.handle({ action: 'save', sessionId: context.sessionId, jobId })).value.state, 'saved');
  assert.equal((await context.manager.loadMediaGallery(context.sessionId)).items.length, 3);
  assert.equal((await context.manager.loadMediaConversionSource(context.sessionId, context.resourceId)).sha256, context.source.sha256);
});

test('destination races, unsafe paths, stale source and revoked document permission fail without overwriting existing bytes', windows, async (t) => {
  const context = await project(t); await stage(context);
  await mkdir(join(context.root, 'assets/converted'), { recursive: true }); await writeFile(join(context.root, 'assets/converted/result.png'), 'external-new-content');
  const result = await context.jobs.handle({ action: 'save', sessionId: context.sessionId, jobId: context.jobId }); assert.equal(result.value.state, 'conflict');
  assert.equal(await readFile(join(context.root, 'assets/converted/result.png'), 'utf8'), 'external-new-content');
  assert.equal((await context.manager.loadMediaConversionSource(context.sessionId, context.resourceId)).sha256, context.source.sha256);
  const other = await project(t);
  assert.notEqual((await stage(other, '../escaped.png')).state, 'staged');
  await stage(other);
  await other.host.capabilities.setProfile({ root: other.root, projectId: other.host.projectId, profile: 'consultar' });
  assert.equal((await other.jobs.handle({ action: 'save', sessionId: other.sessionId, jobId: other.jobId })).value.state, 'error');
  await assert.rejects(() => readFile(join(other.root, 'assets/converted/result.png')), { code: 'ENOENT' });
  const stale = await project(t); const sourcePath = (await stale.manager.loadMediaGallery(stale.sessionId)).items[0];
  const descriptor = JSON.parse(await readFile(join(stale.root, '.a3/resources', sourcePath.resourceId + '.json'), 'utf8'));
  await writeFile(join(stale.root, descriptor.path), await bytesOf('alpha.avif'));
  assert.equal((await stage(stale)).state, 'conflict');
});

test('cancellation during encoding prevents late promotion and also frees the native-work concurrency slot', windows, async (t) => {
  let started;
  const encodingStarted = new Promise((accept) => { started = accept; });
  const runner = (input, signal) => input.action === 'inspect' ? nativeWorker(input, signal) : new Promise((_accept, reject) => {
    started(); signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled encoding'), { code: 'CANCELLED' })), { once: true });
  });
  const context = await project(t, runner);
  const pending = context.jobs.handle({ action: 'convert', sessionId: context.sessionId, jobId: context.jobId,
    settings: settingsFor(context.inspected.source), destination: 'assets/converted/cancelled.png' });
  await encodingStarted;
  const cancellation = await context.jobs.handle({ action: 'cancel', sessionId: context.sessionId, jobId: context.jobId });
  assert.equal(cancellation.value.state, 'cancelled'); assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal((await context.manager.loadMediaGallery(context.sessionId)).items.length, 1);
  await assert.rejects(() => readFile(join(context.root, 'assets/converted/cancelled.png')), { code: 'ENOENT' });
});

test('mount revocation and a different project session block promotion of an already prepared image', windows, async (t) => {
  const context = await project(t), external = join(context.tempRoot, 'mounted'); await mkdir(external);
  const original = await bytesOf('alpha.png'); await writeFile(join(external, 'external.png'), original);
  const mountId = randomUUID(), resourceId = randomUUID();
  await context.manager.approveCanvasDropMount(context.sessionId, mountId, external);
  const workspace = await context.manager.loadCanvasWorkspace(context.sessionId, context.active.workspaces[0].id);
  await context.manager.createCanvasContentNode(context.sessionId, workspace.workspaceId, workspace.revision, { kind: 'image', title: 'Mounted source',
    resourceId, position: { x: 500, y: 0 }, mediaType: 'image/png', dropMode: 'reference', dropMountId: mountId, dropPath: 'external.png' });
  const jobId = randomUUID();
  const inspected = await context.jobs.handle({ action: 'inspect', sessionId: context.sessionId, resourceId, jobId }); assert.equal(inspected.ok, true);
  const output = await context.jobs.handle({ action: 'convert', sessionId: context.sessionId, jobId, settings: settingsFor(inspected.value.source), destination: 'assets/converted/from-mount.png' });
  assert.equal(output.value.state, 'staged');
  await context.host.capabilities.revokeLocalMount({ root: context.root, projectId: context.host.projectId, mountId });
  assert.equal((await context.jobs.handle({ action: 'save', sessionId: context.sessionId, jobId })).value.state, 'error');
  assert.deepEqual(await readFile(join(external, 'external.png')), original);
  await assert.rejects(() => readFile(join(context.root, 'assets/converted/from-mount.png')), { code: 'ENOENT' });
  await stage(context); await context.manager.closeActive(context.sessionId); await context.manager.openFolder(context.root);
  assert.equal((await context.jobs.handle({ action: 'save', sessionId: context.sessionId, jobId: context.jobId })).value.state, 'error');
  await assert.rejects(() => readFile(join(context.root, 'assets/converted/result.png')), { code: 'ENOENT' });
});

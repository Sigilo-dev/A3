import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openProjectService, readMountedResource, validateMountRelativePath } from '../dist/index.js';
import { readLocalMountFile } from '../dist/mounts.js';
import { fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const mountId = id(980);
const resourceId = id(981);
const otherResourceId = id(982);
const operationId = id(983);
const sourceBytes = Buffer.from([0x41, 0x00, 0x42, 0xff, 0x0d, 0x0a]);
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result.value; };

async function setup(t, permission = 'read-only') {
  const { root, tempRoot } = await scratch(t);
  const externalRoot = join(tempRoot, 'external');
  await mkdir(join(externalRoot, 'nested'), { recursive: true });
  await writeFile(join(externalRoot, 'nested', 'source.bin'), sourceBytes);
  const host = await fixtureHost(root, 'mount-test-user', 'trabajar');
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' }), true);
  assert.equal(await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot: externalRoot, permission }), true);
  return { root, tempRoot, externalRoot, host };
}

async function writeMountedDescriptor(root, idValue = resourceId) {
  const value = { schemaVersion: '1.0.0', id: idValue, revision: 1, kind: 'mounted-file', mountId, path: 'nested/source.bin', extensions: {} };
  await writeFile(join(root, '.a3', 'resources', idValue + '.json'), JSON.stringify(value, null, 2) + '\n');
  return value;
}

test('mounted relative paths reject traversal, absolute paths, aliases, and ambiguous Windows names', () => {
  for (const path of ['', '../outside.txt', 'nested/../../outside.txt', '/outside.txt', 'C:/outside.txt',
    'C:\\outside.txt', '\\\\server\\share\\outside.txt', 'nested//source.txt', 'nested/CON.txt', 'nested/trailing.']) {
    assert.throws(() => validateMountRelativePath(path), { name: 'MountPathError' }, path);
  }
  assert.deepEqual(validateMountRelativePath('nested/source.bin'), ['nested', 'source.bin']);
});

test('mount reads require both a local root approval and mount.read; clone requests inherit neither', windows, async (t) => {
  const { root, tempRoot, externalRoot, host } = await setup(t);
  const descriptor = await writeMountedDescriptor(root);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  const opened = ok(await lease.service.openResource(descriptor.id));
  assert.deepEqual(Buffer.from(opened.bytes), sourceBytes);
  assert.equal(opened.source, 'mounted-file');
  assert.equal(opened.path, descriptor.path);
  assert.equal(opened.mountId, mountId);
  assert.equal(JSON.stringify(opened).includes(externalRoot), false);

  const clone = join(tempRoot, 'clone');
  await cp(root, clone, { recursive: true });
  await writeFile(join(clone, '.a3', 'policies.json'), JSON.stringify({ schemaVersion: '1.0.0',
    requests: [{ capability: 'mount.read', mode: 'direct' }, { capability: 'mount.write', mode: 'direct' }] }));
  assert.equal(host.capabilities.getLocalMount({ root: clone, projectId: host.projectId, mountId }), undefined);
  const cloneRead = await readMountedResource({ projectRoot: clone, projectId: host.projectId, actor: host.authenticatedActor,
    broker: host.capabilities, resource: descriptor });
  assert.equal(cloneRead.ok, false);
  assert.equal(cloneRead.diagnostics[0].missingCapability, 'mount.read');
});

test('copy and reference are separate writer actions; reference never edits external bytes', windows, async (t) => {
  const { root, externalRoot, host } = await setup(t);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  const referenceInput = { action: 'reference', operationId: operationId, resourceId, mountId, sourcePath: 'nested/source.bin' };
  const referencePreview = ok(await lease.service.previewMountAction(referenceInput));
  assert.equal(referencePreview.canProceed, true, JSON.stringify(referencePreview));
  assert.deepEqual(referencePreview.destinationConflicts, []);
  const referencePlan = ok(await lease.service.prepareMountAction(referenceInput));
  ok(await lease.service.commit(referencePlan));
  const referenced = ok(await lease.service.openResource(resourceId));
  assert.deepEqual(Buffer.from(referenced.bytes), sourceBytes);
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), sourceBytes);

  const copyInput = { action: 'copy', operationId: id(984), resourceId: otherResourceId, mountId,
    sourcePath: 'nested/source.bin', destinationPath: 'imports/source-copy.bin', mediaType: 'application/octet-stream' };
  const copyPreview = ok(await lease.service.previewMountAction(copyInput));
  assert.equal(copyPreview.canProceed, true, JSON.stringify(copyPreview));
  assert.deepEqual(copyPreview.destinationPaths, ['.a3/resources/' + otherResourceId + '.json', 'imports/source-copy.bin']);
  const copyPlan = ok(await lease.service.prepareMountAction(copyInput));
  ok(await lease.service.commit(copyPlan));
  assert.deepEqual(await readFile(join(root, 'imports', 'source-copy.bin')), sourceBytes);
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), sourceBytes);
  const conflictPreview = ok(await lease.service.previewMountAction({ ...copyInput, operationId: id(985), resourceId: id(986) }));
  assert.equal(conflictPreview.canProceed, false);
  assert.deepEqual(conflictPreview.destinationConflicts, ['imports/source-copy.bin']);
});

test('move is previewed as its own action and denied even when local permission requests writes', windows, async (t) => {
  const { root, externalRoot, host } = await setup(t, 'read-write');
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.write', mode: 'direct' }), true);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  const input = { action: 'move', operationId, resourceId, mountId, sourcePath: 'nested/source.bin', destinationPath: 'imports/moved.bin' };
  const preview = ok(await lease.service.previewMountAction(input));
  assert.equal(preview.sourceAvailable, true);
  assert.equal(preview.canProceed, false);
  assert.equal(preview.reason, 'capability-unavailable:mount.write');
  const rejected = await lease.service.prepareMountAction(input);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.diagnostics.some((diagnostic) => diagnostic.missingCapability === 'mount.write'), true);
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), sourceBytes);
});

test('a changed mounted source conflicts before copy writes anything', windows, async (t) => {
  const { root, externalRoot, host } = await setup(t);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  const input = { action: 'copy', operationId, resourceId, mountId, sourcePath: 'nested/source.bin', destinationPath: 'imports/stale.bin' };
  const plan = ok(await lease.service.prepareMountAction(input));
  const changed = Buffer.from('new external version');
  await writeFile(join(externalRoot, 'nested', 'source.bin'), changed);
  const result = await lease.service.commit(plan);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].detail, 'mounted-source-conflict');
  await assert.rejects(readFile(join(root, 'imports', 'stale.bin')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.a3', 'resources', resourceId + '.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), changed);
});

test('revoking a local binding after preparation blocks the pending copy', windows, async (t) => {
  const { root, externalRoot, host } = await setup(t);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  const input = { action: 'copy', operationId, resourceId, mountId, sourcePath: 'nested/source.bin', destinationPath: 'imports/revoked.bin' };
  const plan = ok(await lease.service.prepareMountAction(input));
  assert.equal(await host.capabilities.revokeLocalMount({ root, projectId: host.projectId, mountId }), true);
  const result = await lease.service.commit(plan);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].detail, 'mount-approval-required');
  await assert.rejects(readFile(join(root, 'imports', 'revoked.bin')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), sourceBytes);
});

test('a moved mount reports a recoverable state and keeps the project reference', windows, async (t) => {
  const { root, tempRoot, externalRoot, host } = await setup(t);
  const descriptor = await writeMountedDescriptor(root);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  await rename(externalRoot, join(tempRoot, 'relocated'));
  assert.equal(host.capabilities.getLocalMount({ root, projectId: host.projectId, mountId }).status, 'root-missing');
  const unavailable = await lease.service.openResource(descriptor.id);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].detail, 'mount-root-missing');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.a3', 'resources', descriptor.id + '.json'), 'utf8')), descriptor);
  assert.equal(await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot: join(tempRoot, 'relocated'), permission: 'read-only' }), true);
  assert.deepEqual(Buffer.from(ok(await lease.service.openResource(descriptor.id)).bytes), sourceBytes);
});

test('revoking a local mount blocks the next read and keeps its descriptor', windows, async (t) => {
  const { root, externalRoot, host } = await setup(t);
  const descriptor = await writeMountedDescriptor(root);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  assert.equal((await lease.service.openResource(descriptor.id)).ok, true);
  assert.equal(await host.capabilities.revokeLocalMount({ root, projectId: host.projectId, mountId }), true);
  const denied = await lease.service.openResource(descriptor.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.diagnostics[0].detail, 'mount-approval-required');
  assert.deepEqual(await readFile(join(root, '.a3', 'resources', descriptor.id + '.json'), 'utf8'), JSON.stringify(descriptor, null, 2) + '\n');
  assert.deepEqual(await readFile(join(externalRoot, 'nested', 'source.bin')), sourceBytes);
});

test('junction escapes and swaps between validation and open fail before returning bytes', windows, async (t) => {
  const { root, tempRoot, externalRoot, host } = await setup(t);
  const binding = host.capabilities.getLocalMount({ root, projectId: host.projectId, mountId });
  assert.equal(binding.status, 'available');
  const outside = join(tempRoot, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'source.bin'), Buffer.from('outside secret'));
  const link = join(externalRoot, 'junction');
  try { symlinkSync(outside, link, 'junction'); }
  catch (error) { t.skip('Windows no permitió crear un junction temporal: ' + (error.code ?? error.message)); return; }
  await assert.rejects(readLocalMountFile(binding, 'junction/source.bin'), { detail: 'mount-link-rejected' });
  await rm(link, { recursive: true, force: true });

  const folder = join(externalRoot, 'nested');
  const saved = join(externalRoot, 'nested-saved');
  const restore = async () => {
    await rm(folder, { recursive: true, force: true });
    await rename(saved, folder);
  };
  await assert.rejects(readLocalMountFile(binding, 'nested/source.bin', 1024, { beforeOpen: async () => {
    await rename(folder, saved); symlinkSync(outside, folder, 'junction');
  } }), { detail: 'mount-path-raced' });
  await restore();
});

test('mount root replacement at the approved path does not silently retarget the reference', windows, async (t) => {
  const { root, tempRoot, externalRoot, host } = await setup(t);
  const descriptor = await writeMountedDescriptor(root);
  const lease = ok(await openProjectService(root, { host, pollMs: 5000 }));
  t.after(() => lease.close());
  await rename(externalRoot, join(tempRoot, 'original-root'));
  await mkdir(externalRoot, { recursive: true });
  await mkdir(join(externalRoot, 'nested'), { recursive: true });
  await writeFile(join(externalRoot, 'nested', 'source.bin'), Buffer.from('replacement'));
  assert.equal(host.capabilities.getLocalMount({ root, projectId: host.projectId, mountId }).status, 'root-changed');
  const unavailable = await lease.service.openResource(descriptor.id);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.diagnostics[0].detail, 'mount-root-changed');
});

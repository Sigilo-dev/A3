import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { revisionsOf } from '@a3/domain';
import { openProjectService, sha256 } from '../dist/index.js';
import { E1, P1, W1, entityPath, fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const worker = fileURLToPath(new URL('./writer-worker.mjs', import.meta.url));
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.diagnostics)); return r.value; };
const rejects = (r, code) => { assert.equal(r.ok, false); if (code) assert.ok(r.diagnostics.some((d) => d.code === code), JSON.stringify(r.diagnostics)); return r; };
async function setup(t, extra = {}) {
  const leases = [];
  t.after(async () => { for (const lease of leases) await lease.close(); });
  const dirs = await scratch(t);
  const host = await fixtureHost(dirs.root, 'test-user');
  const options = { host, pollMs: 5000, debounceMs: 20, ...extra };
  const open = async () => { const lease = ok(await openProjectService(dirs.root, options)); leases.push(lease); return lease; };
  const lease = await open();
  assert.equal(lease.service.state.mode, 'writer', JSON.stringify(lease.service.state));
  return { ...dirs, host, options, lease, service: lease.service, open };
}
function command(service, host, name, payload, n = 10, extra = {}) {
  const snapshot = service.state.project.snapshot;
  return { operationId: id(n), projectId: snapshot.records.find((r) => r.kind === 'project').value.projectId,
    actor: host.authenticatedActor, command: name, payload, expectedRevisions: revisionsOf(snapshot), expectedContentHashes: [],
    scope: { entityIds: snapshot.records.filter((r) => r.kind === 'entity').map((r) => r.value.id) }, ...extra };
}
async function resourcePlan(service, n = 1, bytes = Buffer.from('new source\r\n')) {
  const resource = service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = ok(await service.openResource(resource.value.id));
  const request = { operationId: id(n), resourceId: opened.resourceId, expectedRevision: opened.revision, expectedHash: opened.sha256, bytes };
  return { opened, request, plan: ok(await service.prepareResourceWrite(request)) };
}
function child(root, mode, phase) {
  const process = fork(worker, [root, mode, ...(phase ? [phase] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  process.stderr.on('data', (chunk) => { output += chunk; });
  return { process, output: () => output, exited: once(process, 'exit') };
}
async function nativeEvent(service, predicate, action) {
  let off;
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Native watcher timeout')); }, 4000);
    off = service.subscribe((event) => { if (predicate(event)) { clearTimeout(timer); off(); resolve(event); } });
  });
  await action(); return event;
}
test('resource by ID: exact bytes, descriptor revision, synced intent/backups and no duplicate own events', windows, async (t) => {
  const { service, root, lease, open } = await setup(t);
  const events = []; service.subscribe((e) => events.push(e));
  const newBytes = Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
  const { plan, opened, request } = await resourcePlan(service, 1, newBytes);
  newBytes.fill(0); request.bytes.fill(0); // prepare owns its own bytes
  const receipt = ok(await service.commit(plan));
  assert.equal(receipt.atomic, false);
  assert.equal(receipt.paths.length, 2);
  assert.deepEqual(await readFile(join(root, opened.path)), Buffer.from(plan.proposedBytes(opened.path)));
  assert.equal(ok(await service.openResource(opened.resourceId)).revision, 2);
  const intent = JSON.parse(await readFile(join(root, receipt.transactionPath, 'intent.json')));
  const sourceEntry = intent.entries.find((e) => e.path === opened.path);
  assert.equal(sourceEntry.beforeHash, opened.sha256);
  assert.equal(sourceEntry.revisionBefore, 1); assert.equal(sourceEntry.revisionAfter, 2);
  assert.equal(sha256(await readFile(join(root, sourceEntry.backupPath))), opened.sha256);
  assert.equal(sha256(await readFile(join(root, sourceEntry.stagedPath))), sourceEntry.afterHash);
  assert.deepEqual(intent.actor, { kind: 'user', id: 'test-user' });
  assert.equal(Object.hasOwn(intent, 'prompt'), false); assert.equal(Object.hasOwn(intent, 'content'), false);
  await service.checkExternalChanges(); await service.checkExternalChanges();
  assert.equal(events.filter((e) => e.kind === 'external-change').length, 0);
  assert.equal(events.filter((e) => e.kind === 'committed').length, 1);
  assert.deepEqual(ok(await service.commit(plan)), receipt); // same token never writes twice
  await lease.close();
  assert.equal((await open()).service.state.mode, 'writer');
});
test('domain rename keeps unknown data; concurrent plans on one entity serialize with a conflict', windows, async (t) => {
  const { service, root, host } = await setup(t);
  const a = ok(await service.prepare(command(service, host, 'a3.core.update-entity', { title: 'first' }, 10, { scope: { entityIds: [E1] } })));
  const b = ok(await service.prepare(command(service, host, 'a3.core.update-entity', { title: 'second' }, 11, { scope: { entityIds: [E1] } })));
  const [first, second] = await Promise.all([service.commit(a), service.commit(b)]);
  ok(first); rejects(second, 'REVISION_CONFLICT');
  const value = JSON.parse(await readFile(join(root, entityPath)));
  assert.equal(value.title, 'first'); assert.equal(value.revision, 2);
  assert.ok(value.extensions['demo.notes']);
});
test('stale source revision/hash and revoked permissions never change bytes', windows, async (t) => {
  const { service, root, host } = await setup(t);
  const { opened, request, plan } = await resourcePlan(service);
  const original = await readFile(join(root, opened.path));
  rejects(await service.prepareResourceWrite({ ...request, expectedRevision: 9 }), 'REVISION_CONFLICT');
  rejects(await service.prepareResourceWrite({ ...request, expectedHash: '0'.repeat(64) }), 'REVISION_CONFLICT');
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'document.edit' });
  const deniedCommit = rejects(await service.commit(plan), 'PERMISSION_DENIED');
  assert.equal(deniedCommit.diagnostics[0].missingCapability, 'document.edit');
  assert.deepEqual(await readFile(join(root, opened.path)), original);
  const deniedProposal = rejects(await service.prepare(command(service, host, 'a3.core.update-entity', { title: 'denied' }, 12, { scope: { entityIds: [E1] } })), 'PERMISSION_DENIED');
  assert.equal(deniedProposal.diagnostics[0].missingCapability, 'document.edit');
});
test('same-process windows reuse the service until the final lease closes', windows, async (t) => {
  const { lease, open } = await setup(t);
  const other = await open();
  assert.equal(other.reused, true); assert.equal(other.service, lease.service);
  await lease.close();
  assert.equal(other.service.state.mode, 'writer');
  await other.close();
  const reopened = await open(); assert.notEqual(reopened.service, lease.service);
  const [parallelA, parallelB] = await Promise.all([open(), open()]);
  assert.equal(parallelA.service, parallelB.service);
});
test('another live process receives read-only; owner death releases the OS lock', windows, async (t) => {
  const { lease, root, open } = await setup(t);
  const probe = child(root, 'probe');
  const [reply] = await once(probe.process, 'message');
  assert.equal(reply.mode, 'read-only'); assert.equal(reply.reason, 'writer-busy');
  assert.equal((await probe.exited)[0], 0, probe.output());
  await lease.close();
  const owner = child(root, 'hold');
  t.after(() => { owner.process.kill(); });
  assert.equal((await once(owner.process, 'message'))[0].mode, 'writer');
  owner.process.kill(); await owner.exited;
  assert.equal((await open()).service.state.mode, 'writer');
});
test('native watcher detects edit, invalid JSON, delete and replacement; repeated scans deduplicate', windows, async (t) => {
  const { service, root } = await setup(t);
  const events = []; service.subscribe((e) => events.push(e));
  const original = await readFile(join(root, entityPath));
  const edit = await nativeEvent(service, (e) => e.kind === 'external-change' && e.path === entityPath, () => writeFile(join(root, entityPath), '{invalid json'));
  assert.ok(edit.diagnostics.some((d) => d.detail === 'invalid-json'));
  assert.equal(service.state.externalConflict, true);
  await service.checkExternalChanges(); await service.checkExternalChanges();
  assert.equal(events.filter((e) => e.kind === 'external-change' && e.path === entityPath).length, 1);
  assert.deepEqual(await readFile(join(root, entityPath)), Buffer.from('{invalid json'));
  await writeFile(join(root, entityPath), original); ok(await service.reload());
  const resource = service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const source = join(root, resource.value.path);
  const sourceBytes = await readFile(source);
  const moved = join(root, 'source-kept.md');
  const deletion = await nativeEvent(service, (e) => e.kind === 'external-change' && e.path === resource.value.path, () => rename(source, moved));
  assert.equal(deletion.change, 'deleted');
  await rename(moved, source); ok(await service.reload());
  await writeFile(moved, sourceBytes);
  const replacement = await nativeEvent(service, (e) => e.kind === 'external-change' && e.path === resource.value.path, () => rename(moved, source));
  assert.equal(replacement.change, 'replaced');
  assert.equal(replacement.beforeHash, replacement.afterHash);
});
test('external bytes conflict with prepared write; proposal and external bytes are both retained', windows, async (t) => {
  const { service, root } = await setup(t);
  const { opened, plan } = await resourcePlan(service);
  const external = Buffer.from('external editor content\r\n');
  await writeFile(join(root, opened.path), external);
  rejects(await service.commit(plan), 'REVISION_CONFLICT');
  assert.deepEqual(await readFile(join(root, opened.path)), external);
  assert.deepEqual(Buffer.from(plan.proposedBytes(opened.path)), Buffer.from('new source\r\n'));
  ok(await service.reload());
  assert.equal(service.state.externalConflict, false);
});
test('external recreation between detach/install is never overwritten; restart refuses unresolved intent', windows, async (t) => {
  let root;
  const external = Buffer.from('new external file');
  const setupResult = await setup(t, { fault: async (phase, event) => {
    if (phase === 'before-install' && event.path === 'pages/readme.md') await writeFile(join(root, event.path), external);
  } });
  ({ root } = setupResult);
  const { service, lease, open } = setupResult;
  const { opened, plan } = await resourcePlan(service);
  const failed = rejects(await service.commit(plan), 'REVISION_CONFLICT');
  assert.ok(failed.diagnostics.some((d) => d.path === opened.path));
  assert.equal(failed.recoveryRequired, true);
  assert.deepEqual(await readFile(join(root, opened.path)), external);
  const intent = JSON.parse(await readFile(join(root, failed.transactionPath, 'intent.json')));
  const entry = intent.entries.find((e) => e.path === opened.path);
  assert.equal(sha256(await readFile(join(root, entry.detachedPath))), opened.sha256);
  assert.deepEqual(await readFile(join(root, entry.stagedPath)), Buffer.from('new source\r\n'));
  await lease.close();
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'read-only'); assert.equal(reopened.service.state.reason, 'recovery-required');
  assert.deepEqual(await readFile(join(root, opened.path)), external);
});
test('domain removal quarantines documents, preserving shared source content', windows, async (t) => {
  const { root, service, host } = await setup(t);
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'delete', mode: 'direct' });
  const source = await readFile(join(root, 'pages/readme.md'));
  const plan = ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'placement', id: P1, workspaceId: W1 } }, 21)));
  ok(await service.commit(plan));
  assert.ok(!service.state.project.snapshot.records.some((r) => r.kind === 'placement' && r.value.id === P1));
  assert.deepEqual(await readFile(join(root, 'pages/readme.md')), source);
  assert.equal(service.state.mode, 'writer');
});
test('A3-046: an interrupted deletion with every destination applied is confirmed from detached copies', windows, async (t) => {
  const setupResult = await setup(t);
  const { root, service, host, lease, open, options } = setupResult;
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'delete', mode: 'direct' });
  const placementPath = service.state.project.documents.find((d) => d.record?.kind === 'placement' && d.record.value.id === P1).location.path;
  const placementBytes = await readFile(join(root, placementPath));
  options.fault = async (phase) => { if (phase === 'before-commit') throw new Error('injected interruption after all delete effects'); };
  const proposal = ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'placement', id: P1, workspaceId: W1 } }, 44)));
  const failure = rejects(await service.commit(proposal));
  assert.equal(failure.recoveryRequired, true);
  await lease.close(); options.fault = undefined;
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'writer', JSON.stringify(reopened.service.state.recoveryDiagnostics));
  assert.ok(!reopened.service.state.project.snapshot.records.some((r) => r.kind === 'placement' && r.value.id === P1));
  const operation = (await readdir(join(root, '.a3/local/transactions'))).find((name) => name !== 'quarantine');
  const intent = JSON.parse(await readFile(join(root, '.a3/local/transactions', operation, 'intent.json'), 'utf8'));
  const entry = intent.entries.find((item) => item.path === placementPath);
  assert.equal(sha256(await readFile(join(root, entry.detachedPath))), sha256(placementBytes));
  const events = (await readFile(join(root, '.a3/local/transactions', operation, 'progress.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, 'recovery-committed');
});
test('domain resource move stages source and descriptor without overwriting an existing target', windows, async (t) => {
  const { root, service, host } = await setup(t);
  const resource = service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const source = ok(await service.openResource(resource.value.id));
  const request = command(service, host, 'a3.core.move-resource', { resourceId: resource.value.id, location: { kind: 'project-file', path: 'pages/moved.md' } }, 30,
    { expectedContentHashes: [{ resourceId: resource.value.id, hash: source.sha256 }] });
  const plan = ok(await service.prepare(request));
  ok(await service.commit(plan));
  assert.deepEqual(await readFile(join(root, 'pages/moved.md')), Buffer.from(source.bytes));
  await assert.rejects(readFile(join(root, source.path)), { code: 'ENOENT' });
  assert.equal(ok(await service.openResource(source.resourceId)).path, 'pages/moved.md');
});
test('removing an unused resource descriptor retains its bytes without a false deletion conflict', windows, async (t) => {
  const { root, service, host } = await setup(t);
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'delete', mode: 'direct' });
  const resource = service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const source = await readFile(join(root, resource.value.path));
  ok(await service.commit(ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'entity', id: E1 } }, 31)))));
  ok(await service.commit(ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'resource', id: resource.value.id } }, 32)))));
  assert.deepEqual(await readFile(join(root, resource.value.path)), source);
  assert.equal(service.state.mode, 'writer');
  assert.equal(service.state.externalConflict, false);
});
for (const phase of ['after-intent', 'after-staging', 'after-detach', 'before-install', 'after-install', 'before-commit', 'after-commit']) test(`A3-046: process exit at ${phase}; restart deterministically recovers every file`, windows, async (t) => {
  const { root, lease, open } = await setup(t);
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = ok(await lease.service.openResource(resource.value.id));
  const descriptorPath = lease.service.state.project.documents.find((d) => d.record?.kind === 'resource' && d.record.value.id === resource.value.id).location.path;
  const beforeSource = await readFile(join(root, opened.path));
  const beforeDescriptor = await readFile(join(root, descriptorPath));
  await lease.close();
  const workerProcess = child(root, 'write', phase);
  const [code] = await workerProcess.exited;
  assert.equal(code, 86, workerProcess.output());
  if (phase === 'after-intent') {
    const interruptedPreparation = child(root, 'recover', 'recovery-after-backup-check');
    assert.equal((await interruptedPreparation.exited)[0], 86, interruptedPreparation.output());
  }
  const reopened = await open();
  const shouldCommit = phase === 'before-commit' || phase === 'after-commit';
  assert.equal(reopened.service.state.mode, 'writer', JSON.stringify(reopened.service.state.recoveryDiagnostics));
  if (shouldCommit) {
    assert.deepEqual(await readFile(join(root, opened.path)), Buffer.from('new worker content\r\n'));
    assert.equal(JSON.parse(await readFile(join(root, descriptorPath))).revision, JSON.parse(beforeDescriptor).revision + 1);
  } else {
    assert.deepEqual(await readFile(join(root, opened.path)), beforeSource);
    assert.deepEqual(await readFile(join(root, descriptorPath)), beforeDescriptor);
  }
  const operations = await readdir(join(root, '.a3/local/transactions'));
  const operation = operations.find((name) => name !== 'quarantine');
  assert.ok(operation);
  const events = (await readFile(join(root, '.a3/local/transactions', operation, 'progress.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, shouldCommit && phase === 'before-commit' ? 'recovery-committed' :
    shouldCommit ? 'committed' : 'recovery-rolled-back');
  await reopened.close();
  const reopenedTwice = await open();
  assert.equal(reopenedTwice.service.state.mode, 'writer');
  if (shouldCommit) assert.deepEqual(await readFile(join(root, opened.path)), Buffer.from('new worker content\r\n'));
  else assert.deepEqual(await readFile(join(root, opened.path)), beforeSource);
});
test('A3-046: interruption during rollback resumes idempotently on the next process', windows, async (t) => {
  const { root, lease, open } = await setup(t);
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = ok(await lease.service.openResource(resource.value.id));
  const descriptorPath = lease.service.state.project.documents.find((d) => d.record?.kind === 'resource' && d.record.value.id === resource.value.id).location.path;
  const beforeSource = await readFile(join(root, opened.path));
  const beforeDescriptor = await readFile(join(root, descriptorPath));
  await lease.close();
  const writer = child(root, 'write', 'after-install');
  assert.equal((await writer.exited)[0], 86, writer.output());
  const recovery = child(root, 'recover', 'recovery-after-entry');
  assert.equal((await recovery.exited)[0], 86, recovery.output());
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'writer', JSON.stringify(reopened.service.state.recoveryDiagnostics));
  assert.deepEqual(await readFile(join(root, opened.path)), beforeSource);
  assert.deepEqual(await readFile(join(root, descriptorPath)), beforeDescriptor);
  await reopened.close();
  assert.equal((await open()).service.state.mode, 'writer');
});
test('A3-046: interruption while confirming an all-applied operation does not apply it twice', windows, async (t) => {
  const { root, lease, open } = await setup(t);
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = ok(await lease.service.openResource(resource.value.id));
  const descriptorPath = lease.service.state.project.documents.find((d) => d.record?.kind === 'resource' && d.record.value.id === resource.value.id).location.path;
  const beforeRevision = JSON.parse(await readFile(join(root, descriptorPath))).revision;
  await lease.close();
  const writer = child(root, 'write', 'before-commit');
  assert.equal((await writer.exited)[0], 86, writer.output());
  const recovery = child(root, 'recover', 'recovery-before-finalize');
  assert.equal((await recovery.exited)[0], 86, recovery.output());
  const finalizedRecovery = child(root, 'recover', 'recovery-after-finalize');
  assert.equal((await finalizedRecovery.exited)[0], 86, finalizedRecovery.output());
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'writer', JSON.stringify(reopened.service.state.recoveryDiagnostics));
  assert.deepEqual(await readFile(join(root, opened.path)), Buffer.from('new worker content\r\n'));
  assert.equal(JSON.parse(await readFile(join(root, descriptorPath))).revision, beforeRevision + 1);
  const operation = (await readdir(join(root, '.a3/local/transactions'))).find((name) => name !== 'quarantine');
  const log = join(root, '.a3/local/transactions', operation, 'progress.ndjson');
  const beforeCount = (await readFile(log, 'utf8')).trim().split('\n').length;
  await reopened.close();
  assert.equal((await open()).service.state.mode, 'writer');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, beforeCount);
});
test('A3-046: later external bytes are preserved with both journal versions and reported as conflict', windows, async (t) => {
  const { root, lease, open } = await setup(t);
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const opened = ok(await lease.service.openResource(resource.value.id));
  const beforeSource = await readFile(join(root, opened.path));
  await lease.close();
  const writer = child(root, 'write', 'after-install');
  assert.equal((await writer.exited)[0], 86, writer.output());
  const external = Buffer.from('external edit after interrupted write\r\n');
  await writeFile(join(root, opened.path), external);
  const interruptedRecovery = child(root, 'recover', 'recovery-before-conflict');
  assert.equal((await interruptedRecovery.exited)[0], 86, interruptedRecovery.output());
  const recordedConflict = child(root, 'recover', 'recovery-after-conflict');
  assert.equal((await recordedConflict.exited)[0], 86, recordedConflict.output());
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'read-only');
  assert.equal(reopened.service.state.reason, 'recovery-required');
  assert.ok(reopened.service.state.recoveryDiagnostics.some((d) => d.detail === 'recovery-external-change'));
  assert.deepEqual(await readFile(join(root, opened.path)), external);
  const operation = (await readdir(join(root, '.a3/local/transactions'))).find((name) => name !== 'quarantine');
  const intent = JSON.parse(await readFile(join(root, '.a3/local/transactions', operation, 'intent.json'), 'utf8'));
  const sourceEntry = intent.entries.find((entry) => entry.path === opened.path);
  assert.equal(sha256(await readFile(join(root, sourceEntry.backupPath))), sha256(beforeSource));
  assert.deepEqual(await readFile(join(root, sourceEntry.stagedPath)), Buffer.from('new worker content\r\n'));
});
test('A3-047: external deletion after an installed file is treated as conflict, not undone', windows, async (t) => {
  const { root, lease, open } = await setup(t);
  const resource = lease.service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const descriptorPath = lease.service.state.project.documents.find((d) => d.record?.kind === 'resource' && d.record.value.id === resource.value.id).location.path;
  const beforeDescriptor = await readFile(join(root, descriptorPath));
  await lease.close();
  const writer = child(root, 'write', 'after-install');
  assert.equal((await writer.exited)[0], 86, writer.output());
  await unlink(join(root, descriptorPath));
  const reopened = await open();
  assert.equal(reopened.service.state.mode, 'read-only');
  assert.ok(reopened.service.state.recoveryDiagnostics.some((d) => d.detail === 'recovery-external-change' && d.path === descriptorPath));
  await assert.rejects(readFile(join(root, descriptorPath)), { code: 'ENOENT' });
  const operation = (await readdir(join(root, '.a3/local/transactions'))).find((name) => name !== 'quarantine');
  const intent = JSON.parse(await readFile(join(root, '.a3/local/transactions', operation, 'intent.json'), 'utf8'));
  const entry = intent.entries.find((item) => item.path === descriptorPath);
  assert.equal(sha256(await readFile(join(root, entry.backupPath))), sha256(beforeDescriptor));
  assert.equal(sha256(await readFile(join(root, entry.stagedPath))), entry.afterHash);
});
test('truncated progress and missing intent are fail-closed, without repair', windows, async (t) => {
  const { root, service, lease, open } = await setup(t);
  const { plan } = await resourcePlan(service);
  const receipt = ok(await service.commit(plan));
  await lease.close();
  const log = join(root, receipt.transactionPath, 'progress.ndjson');
  await writeFile(log, (await readFile(log)).subarray(0, -8));
  const isolation = child(root, 'recover', 'recovery-before-quarantine');
  assert.equal((await isolation.exited)[0], 86, isolation.output());
  const truncated = await open(); assert.equal(truncated.service.state.reason, 'recovery-required');
  assert.ok(truncated.service.state.recoveryDiagnostics.some((d) => d.detail === 'journal-quarantined'));
  assert.ok((await readdir(join(root, '.a3/local/transactions/quarantine'))).length === 1);
  await truncated.close();
  await mkdir(join(root, '.a3/local/transactions', id(300)));
  const interruptedQuarantine = child(root, 'recover', 'recovery-after-quarantine');
  assert.equal((await interruptedQuarantine.exited)[0], 86, interruptedQuarantine.output());
  const missingIntent = await open();
  assert.equal(missingIntent.service.state.reason, 'recovery-required');
  assert.equal((await readdir(join(root, '.a3/local/transactions/quarantine'))).length, 2);
});

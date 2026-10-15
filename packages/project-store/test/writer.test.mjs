import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { revisionsOf } from '@a3/domain';
import { openProjectService, sha256 } from '../dist/index.js';
import { E1, P1, W1, entityPath, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const worker = fileURLToPath(new URL('./writer-worker.mjs', import.meta.url));
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.diagnostics)); return r.value; };
const rejects = (r, code) => { assert.equal(r.ok, false); if (code) assert.ok(r.diagnostics.some((d) => d.code === code), JSON.stringify(r.diagnostics)); return r; };
async function setup(t, extra = {}) {
  const leases = [];
  t.after(async () => { for (const lease of leases) await lease.close(); });
  const dirs = await scratch(t);
  const host = { authenticatedActor: { kind: 'user', id: 'test-user' }, domain: { authorize: () => true }, authorizeAccess: () => true };
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
  assert.equal(sha256(await readFile(join(root, sourceEntry.backupPath))), opened.sha256);
  assert.equal(sha256(await readFile(join(root, sourceEntry.stagedPath))), sourceEntry.afterHash);
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
  host.authorizeAccess = (r) => r.operation !== 'write';
  rejects(await service.commit(plan), 'PERMISSION_DENIED');
  assert.deepEqual(await readFile(join(root, opened.path)), original);
  host.authorizeAccess = () => true;
  host.domain.authorize = () => false;
  rejects(await service.prepare(command(service, host, 'a3.core.update-entity', { title: 'denied' }, 12, { scope: { entityIds: [E1] } })), 'PERMISSION_DENIED');
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
  const source = await readFile(join(root, 'pages/readme.md'));
  const plan = ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'placement', id: P1, workspaceId: W1 } }, 21)));
  ok(await service.commit(plan));
  assert.ok(!service.state.project.snapshot.records.some((r) => r.kind === 'placement' && r.value.id === P1));
  assert.deepEqual(await readFile(join(root, 'pages/readme.md')), source);
  assert.equal(service.state.mode, 'writer');
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
  const resource = service.state.project.snapshot.records.find((r) => r.kind === 'resource');
  const source = await readFile(join(root, resource.value.path));
  ok(await service.commit(ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'entity', id: E1 } }, 31)))));
  ok(await service.commit(ok(await service.prepare(command(service, host, 'a3.core.delete', { ref: { kind: 'resource', id: resource.value.id } }, 32)))));
  assert.deepEqual(await readFile(join(root, resource.value.path)), source);
  assert.equal(service.state.mode, 'writer');
  assert.equal(service.state.externalConflict, false);
});
for (const phase of ['after-intent', 'after-staging', 'after-detach', 'after-install', 'before-commit', 'after-commit']) test(`A3-046: process exit at ${phase}; restart does not accept pending mixed state`, windows, async (t) => {
  const { root, lease, open } = await setup(t);
  await lease.close();
  const workerProcess = child(root, 'write', phase);
  const [code] = await workerProcess.exited;
  assert.equal(code, 86, workerProcess.output());
  const reopened = await open();
  if (phase === 'after-commit') assert.equal(reopened.service.state.mode, 'writer');
  else { assert.equal(reopened.service.state.mode, 'read-only'); assert.equal(reopened.service.state.reason, 'recovery-required'); }
  const operations = await readdir(join(root, '.a3/local/transactions'));
  assert.equal(operations.length, 1);
});
test('truncated progress and missing intent are fail-closed, without repair', windows, async (t) => {
  const { root, service, lease, open } = await setup(t);
  const { plan } = await resourcePlan(service);
  const receipt = ok(await service.commit(plan));
  await lease.close();
  const log = join(root, receipt.transactionPath, 'progress.ndjson');
  await writeFile(log, (await readFile(log)).subarray(0, -8));
  const truncated = await open(); assert.equal(truncated.service.state.reason, 'recovery-required');
  await truncated.close();
  await mkdir(join(root, '.a3/local/transactions', id(300)));
  assert.equal((await open()).service.state.reason, 'recovery-required');
});

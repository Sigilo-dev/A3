import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openProjectService, sha256 } from '../dist/index.js';
import { listSnapshots, readSnapshot } from '../dist/snapshots.js';
import { createSnapshot, enforceSnapshotRetention } from '../dist/snapshots.js';
import { entityPath, fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const worker = fileURLToPath(new URL('./migration-worker.mjs', import.meta.url));
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result.value; };
const migrationSteps = [
  { id: 'fixture.project.0.9.0-to-1.0.0', scope: 'project', fromVersion: '0.9.0', toVersion: '1.0.0', allowedPointers: [], validateInput: (value) => value.formatVersion === '0.9.0' && Number.isSafeInteger(value.revision), transform: (value) => value },
  { id: 'fixture.entity.0.9.0-to-1.0.0', scope: 'entity', fromVersion: '0.9.0', toVersion: '1.0.0', allowedPointers: [], validateInput: (value) => value.schemaVersion === '0.9.0' && typeof value.title === 'string', transform: (value) => value }
];
async function open(root, extra = {}) {
  const result = await openProjectService(root, { host: await fixtureHost(root, 'maintenance-fixture-user'), pollMs: 5000, debounceMs: 20, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.value;
}
function child(root, operationId, phase) {
  const process = fork(worker, [root, operationId, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  process.stderr.on('data', (chunk) => { output += chunk; });
  return { process, output: () => output, exited: once(process, 'exit') };
}
async function seedLegacy(t) {
  const { root } = await scratch(t);
  const manifestPath = join(root, 'a3.project.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.formatVersion = '0.9.0';
  manifest.extensions = { 'fixture.project-opaque': { keep: true } };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const entityFile = join(root, entityPath);
  const entity = JSON.parse(await readFile(entityFile, 'utf8'));
  entity.schemaVersion = '0.9.0';
  entity.extensions = { 'fixture.opaque': { keep: true, nested: ['untouched'] } };
  await writeFile(entityFile, JSON.stringify(entity, null, 2) + '\n');
  return { root, manifestPath, entityFile };
}

test('snapshots preserve exact preimages; retention removes oldest first and catalogs only verified bytes', windows, async (t) => {
  const { root } = await scratch(t);
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const firstBytes = await readFile(join(root, entityPath));
  const start = new Date('2026-01-01T00:00:00.000Z');
  const first = ok(await createSnapshot(root, { snapshotId: id(901), projectId: manifest.projectId, operationId: id(902), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(firstBytes) }], retentionDays: 30, maxBytes: 100_000, now: start }));
  const returned = ok(await readSnapshot(root, first.snapshotId, manifest.projectId));
  assert.deepEqual(returned.files[0].bytes, firstBytes);
  const changed = Buffer.from([...firstBytes, 0x20]);
  await writeFile(join(root, entityPath), changed);
  const second = ok(await createSnapshot(root, { snapshotId: id(903), projectId: manifest.projectId, operationId: id(904), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(changed) }], retentionDays: 30, maxBytes: changed.length, now: new Date('2026-01-02T00:00:00.000Z') }));
  const retained = ok(await enforceSnapshotRetention(root, { retentionDays: 30, maxBytes: changed.length }, new Date('2026-01-02T00:00:00.000Z')));
  assert.equal(retained.overBudget, false);
  assert.deepEqual(ok(await listSnapshots(root, manifest.projectId)).map((snapshot) => snapshot.snapshotId), [second.snapshotId]);
  const old = await readSnapshot(root, first.snapshotId, manifest.projectId);
  assert.equal(old.ok, false);
});

test('recovery snapshots exclude Git metadata, local state, caches and credential paths', windows, async (t) => {
  const { root } = await scratch(t), manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const entityBytes = await readFile(join(root, entityPath));
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(921), projectId: manifest.projectId, operationId: id(922), reason: 'batch', files: [
    { path: entityPath, expectedHash: sha256(entityBytes) }, { path: '.env.local', expectedHash: null }, { path: '.a3/local/session.json', expectedHash: null },
    { path: '.git/config', expectedHash: null }, { path: 'credentials.json', expectedHash: null }, { path: 'node_modules/cache/item.bin', expectedHash: null }, { path: 'private-key.pem', expectedHash: null },
    { path: 'dist/application/source.ts', expectedHash: null }, { path: 'build/decisions.md', expectedHash: null }
  ] }));
  assert.equal(snapshot.fileCount, 3);
  const recoveredPaths = ok(await readSnapshot(root, snapshot.snapshotId, manifest.projectId)).files.map((file) => file.path);
  assert.ok(recoveredPaths.includes(entityPath));
  assert.ok(recoveredPaths.includes('dist/application/source.ts'));
  assert.ok(recoveredPaths.includes('build/decisions.md'));
});

test('snapshot restore can be reviewed before commit and rejects a later external file edit', windows, async (t) => {
  const { root } = await scratch(t), entityFile = join(root, entityPath);
  const original = JSON.parse(await readFile(entityFile, 'utf8'));
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(923), projectId: original.projectId ?? JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8')).projectId,
    operationId: id(924), reason: 'batch', files: [{ path: entityPath, expectedHash: sha256(await readFile(entityFile)) }] }));
  const changed = { ...original, revision: original.revision + 1, title: 'Uncommitted local edit' };
  await writeFile(entityFile, JSON.stringify(changed, null, 2) + '\n');
  const lease = await open(root); t.after(() => lease.close());
  const prepared = ok(await lease.service.prepareSnapshotRestore(snapshot.snapshotId, id(925)));
  assert.equal(JSON.parse(Buffer.from(prepared.proposedBytes(entityPath)).toString('utf8')).title, original.title);
  await writeFile(entityFile, JSON.stringify({ ...changed, title: 'External edit after preview' }, null, 2) + '\n');
  const committed = await lease.service.commit(prepared);
  assert.equal(committed.ok, false);
  assert.equal(JSON.parse(await readFile(entityFile, 'utf8')).title, 'External edit after preview');
});

test('an interrupted write keeps its over-budget snapshot while the D1 transaction is pending', windows, async (t) => {
  const { root } = await scratch(t);
  const lease = ok(await openProjectService(root, { host: await fixtureHost(root, 'quota-user'), pollMs: 5000, snapshotMaxBytes: 1,
    fault: (phase) => { if (phase === 'after-intent') throw new Error('fixture interruption'); } }));
  t.after(() => lease.close());
  const service = lease.service;
  const resource = service.state.project.snapshot.records.find((record) => record.kind === 'resource').value;
  const opened = ok(await service.openResource(resource.id));
  const plan = ok(await service.prepareResourceWrite({ operationId: id(905), resourceId: opened.resourceId, expectedRevision: opened.revision,
    expectedHash: opened.sha256, bytes: Buffer.from('prepared bytes') }));
  const result = await service.commit(plan);
  assert.equal(result.ok, false);
  assert.equal(result.recoveryRequired, true);
  const projectId = service.state.project.snapshot.records.find((record) => record.kind === 'project').value.projectId;
  const catalog = ok(await listSnapshots(root, projectId));
  assert.ok(catalog.some((snapshot) => snapshot.snapshotId === id(905)));
  const retention = ok(await enforceSnapshotRetention(root, { retentionDays: 30, maxBytes: 1 }));
  assert.equal(retention.overBudget, true);
  assert.ok((await readdir(join(root, '.a3/local/recovery/snapshots'))).includes(id(905)));
});

test('retention keeps snapshots while a quarantined journal has no trustworthy operation ID', windows, async (t) => {
  const { root } = await scratch(t);
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const bytes = await readFile(join(root, entityPath));
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(911), projectId: manifest.projectId, operationId: id(912), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(bytes) }] }));
  await mkdir(join(root, '.a3/local/transactions/quarantine/q-unreadable-journal'), { recursive: true });
  await writeFile(join(root, '.a3/local/transactions/quarantine/q-unreadable-journal', 'progress.ndjson'), '{ truncated');
  const retention = ok(await enforceSnapshotRetention(root, { retentionDays: 30, maxBytes: 1 }));
  assert.equal(retention.overBudget, true);
  assert.ok(ok(await listSnapshots(root, manifest.projectId)).some((entry) => entry.snapshotId === snapshot.snapshotId));
});

test('degraded open keeps corrupt bytes and can explicitly restore a valid snapshot with a new revision', windows, async (t) => {
  const { root } = await scratch(t);
  const first = await open(root);
  const service = first.service;
  const original = await readFile(join(root, entityPath));
  const projectId = service.state.project.snapshot.records.find((record) => record.kind === 'project').value.projectId;
  const snapshot = ok(await service.createSnapshot(id(906), 'batch', [entityPath]));
  await first.close();
  const corrupt = Buffer.from('{ invalid JSON preserved\r\n');
  await writeFile(join(root, entityPath), corrupt);
  const reopened = await open(root);
  t.after(() => reopened.close());
  assert.equal(reopened.service.state.project.mode, 'degraded');
  assert.equal(reopened.service.state.mode, 'read-only');
  assert.equal(reopened.service.state.externalConflict, false, JSON.stringify(reopened.service.state.recoveryDiagnostics));
  assert.ok(reopened.service.state.project.snapshot.records.some((record) => record.kind === 'project'));
  const corruptDocument = reopened.service.state.project.documents.find((document) => document.location.path === entityPath);
  assert.equal(corruptDocument.status, 'invalid');
  assert.deepEqual(Buffer.from(corruptDocument.originalBytes()), corrupt);
  assert.deepEqual(await readFile(join(root, entityPath)), corrupt);
  const restored = ok(await reopened.service.restoreSnapshot(snapshot.snapshotId, id(907)));
  assert.equal(restored.snapshotId, id(907));
  const value = JSON.parse(await readFile(join(root, entityPath), 'utf8'));
  assert.equal(value.revision, 2);
  assert.deepEqual(value.extensions, JSON.parse(original.toString()).extensions);
  assert.equal(reopened.service.state.project.mode, 'ready');
  const returnPoint = ok(await readSnapshot(root, restored.snapshotId, projectId));
  assert.deepEqual(returnPoint.files.find((file) => file.path === entityPath).bytes, corrupt);
});

test('unknown major project format stays read-only and unchanged', windows, async (t) => {
  const { root } = await scratch(t);
  const path = join(root, 'a3.project.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.formatVersion = '2.0.0';
  const original = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path, original);
  const lease = await open(root, { migrationSteps });
  t.after(() => lease.close());
  assert.equal(lease.service.state.mode, 'read-only');
  assert.equal(lease.service.state.project.mode, 'read-only');
  const attempt = await lease.service.migrateProject(id(908));
  assert.equal(attempt.ok, false);
  assert.deepEqual(await readFile(path), original);
  assert.equal((await readdir(join(root, '.a3/local/transactions')).catch(() => [])).length, 0);
});

for (const stopAt of ['migration-after-stage', 'migration-after-apply']) test('registered migration resumes after process interruption at ' + stopAt, windows, async (t) => {
  const { root, manifestPath, entityFile } = await seedLegacy(t);
  const operationId = stopAt === 'migration-after-stage' ? id(909) : id(910);
  const workerProcess = child(root, operationId, stopAt);
  assert.equal((await workerProcess.exited)[0], 86, workerProcess.output());
  const lease = await open(root, { migrationSteps });
  t.after(() => lease.close());
  const result = ok(await lease.service.migrateProject(operationId));
  assert.equal(result.resumed, true);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entity = JSON.parse(await readFile(entityFile, 'utf8'));
  assert.equal(manifest.formatVersion, '1.0.0');
  assert.equal(manifest.revision, 2);
  assert.deepEqual(manifest.extensions, { 'fixture.project-opaque': { keep: true } });
  assert.equal(entity.schemaVersion, '1.0.0');
  assert.equal(entity.revision, 2);
  assert.deepEqual(entity.extensions, { 'fixture.opaque': { keep: true, nested: ['untouched'] } });
  assert.equal(lease.service.state.project.mode, 'ready');
  const repeat = ok(await lease.service.migrateProject(operationId));
  assert.equal(repeat.transactionOperationId, null);
  assert.equal(JSON.parse(await readFile(entityFile, 'utf8')).revision, 2);
});

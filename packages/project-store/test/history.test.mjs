import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager, sha256 } from '../dist/index.js';
import { createSnapshot, readSnapshot } from '../dist/snapshots.js';
import { entityPath, fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result.value; };

test('A3-038 local history shows uncommitted edits and applies a reviewed restore with a durable return point', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), entityFile = join(root, entityPath), manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const originalBytes = await readFile(entityFile), original = JSON.parse(originalBytes);
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(931), projectId: manifest.projectId, operationId: id(932), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(originalBytes) }] }));
  const edited = { ...original, revision: original.revision + 1, title: 'Local edit without Git commit' };
  await writeFile(entityFile, JSON.stringify(edited, null, 2) + '\n');
  const host = await fixtureHost(root, 'history-panel-test');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const state = await manager.listHistorySnapshots(active.sessionId);
  assert.ok(state.snapshots.some((item) => item.snapshotId === snapshot.snapshotId));
  const preview = await manager.prepareHistoryRestore(active.sessionId, snapshot.snapshotId);
  assert.match(preview.changes[0].diff, /Local edit without Git commit/);
  assert.match(preview.changes[0].diff, new RegExp(original.title));
  const receipt = await manager.applyHistoryRestore(active.sessionId, preview.token);
  assert.ok(receipt.snapshotId);
  assert.equal(JSON.parse(await readFile(entityFile, 'utf8')).title, original.title);
  const returnPoint = ok(await readSnapshot(root, receipt.snapshotId, manifest.projectId));
  assert.equal(JSON.parse(Buffer.from(returnPoint.files.find((file) => file.path === entityPath).bytes).toString('utf8')).title, edited.title);
  assert.equal(receipt.atomic, false);
});

test('A3-038 history apply uses the journal and remains recoverable after an interrupted replacement', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), entityFile = join(root, entityPath), manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const original = JSON.parse(await readFile(entityFile, 'utf8'));
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(933), projectId: manifest.projectId, operationId: id(934), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(await readFile(entityFile)) }] }));
  await writeFile(entityFile, JSON.stringify({ ...original, revision: original.revision + 1, title: 'Before crash' }, null, 2) + '\n');
  const host = await fixtureHost(root, 'history-crash-test'); let crash = false;
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'first-catalog'), host,
    fault: (phase) => { if (crash && phase === 'after-install') { crash = false; throw new Error('injected interruption'); } } });
  const active = (await manager.openFolder(root)).active, preview = await manager.prepareHistoryRestore(active.sessionId, snapshot.snapshotId);
  crash = true;
  await assert.rejects(manager.applyHistoryRestore(active.sessionId, preview.token));
  await manager.dispose();
  const recovered = new LocalProjectManager({ stateDirectory: join(tempRoot, 'recovered-catalog'), host }); t.after(() => recovered.dispose());
  const reopened = (await recovered.openFolder(root)).active;
  const state = await recovered.listHistorySnapshots(reopened.sessionId);
  assert.ok(state.snapshots.some((item) => item.snapshotId === snapshot.snapshotId));
  const title = JSON.parse(await readFile(entityFile, 'utf8')).title;
  assert.ok([original.title, 'Before crash'].includes(title));
});

test('history restoration refuses dirty editor buffers both before preview and before apply', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), entityFile = join(root, entityPath), manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const originalBytes = await readFile(entityFile), original = JSON.parse(originalBytes);
  const snapshot = ok(await createSnapshot(root, { snapshotId: id(935), projectId: manifest.projectId, operationId: id(936), reason: 'batch',
    files: [{ path: entityPath, expectedHash: sha256(originalBytes) }] }));
  const edited = { ...original, revision: original.revision + 1, title: 'Local edit' };
  await writeFile(entityFile, JSON.stringify(edited, null, 2) + '\n');
  const host = await fixtureHost(root, 'history-dirty-buffer-test'); let dirty = true;
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host, hasDirtyBuffers: async () => dirty }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  await assert.rejects(manager.prepareHistoryRestore(active.sessionId, snapshot.snapshotId), { code: 'UNSAVED_CHANGES' });
  dirty = false; const preview = await manager.prepareHistoryRestore(active.sessionId, snapshot.snapshotId);
  dirty = true; await assert.rejects(manager.applyHistoryRestore(active.sessionId, preview.token), { code: 'UNSAVED_CHANGES' });
  assert.equal(JSON.parse(await readFile(entityFile, 'utf8')).title, edited.title);
  await manager.cancelHistoryRestore(active.sessionId, preview.token);
});

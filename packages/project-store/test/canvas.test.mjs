import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager, openProjectService } from '../dist/index.js';
import { scratch, fixtureHost, W1, E1 } from './fixture.mjs';
const windows = { skip: process.platform !== 'win32' };
const W2 = '00000000-0000-4000-8000-000000000007';
const R1 = '00000000-0000-4000-8000-000000000004';
const pathOf = (root, id) => join(root, '.a3', 'workspaces', id, 'workspace.json');

test('A3-006/007: viewport drafts flush on close, remain independent per workspace and reopen without drift', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const document = JSON.parse(await readFile(pathOf(root, W1), 'utf8'));
  document.viewport['future.camera'] = { retained: true }; document.extensions['future.keep'] = ['unknown'];
  await writeFile(pathOf(root, W1), JSON.stringify(document, null, 2) + '\n');
  const host = await fixtureHost(root, 'canvas-user');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const first = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const second = await manager.loadCanvasWorkspace(active.sessionId, W2);
  const v1 = { x: -1e12 + 0.125, y: 1e12 - 0.25, zoom: 0.73 };
  const v2 = { x: 12.125, y: -45.75, zoom: 8 };
  await manager.stageCanvasViewport(active.sessionId, W1, first.revision, v1);
  await manager.stageCanvasViewport(active.sessionId, W2, second.revision, v2);
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).pending, true);
  // No canonical write per pointer event.
  assert.deepEqual(JSON.parse(await readFile(pathOf(root, W1), 'utf8')).viewport, document.viewport);
  await manager.closeActive(active.sessionId);
  const reopened = (await manager.openFolder(root)).active;
  assert.deepEqual((await manager.loadCanvasWorkspace(reopened.sessionId, W1)).viewport, v1);
  assert.deepEqual((await manager.loadCanvasWorkspace(reopened.sessionId, W2)).viewport, v2);
  const saved = await readFile(pathOf(root, W1)); const value = JSON.parse(saved);
  assert.deepEqual(value.viewport['future.camera'], { retained: true }); assert.deepEqual(value.extensions, document.extensions);
  await manager.closeActive(reopened.sessionId); await manager.openFolder(root);
  assert.deepEqual(await readFile(pathOf(root, W1)), saved, 'load/close without interaction preserves bytes and revision');
  await assert.rejects(manager.loadCanvasWorkspace(active.sessionId, W1), { code: 'STALE_SESSION' });
});
test('viewport writes enforce revisions, broker revocation and read-only inspection', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'canvas-permissions');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active; const base = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const before = await readFile(pathOf(root, W1));
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision + 1, { x: 1, y: 2, zoom: 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: NaN, y: 2, zoom: 1 }), { code: 'INVALID_VIEWPORT' });
  await manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 1, y: 2, zoom: 1 });
  assert.equal(await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' }), true);
  await assert.rejects(manager.flushCanvasWorkspace(active.sessionId, W1));
  assert.deepEqual(await readFile(pathOf(root, W1)), before);
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).canWrite, false);
  await manager.discardCanvasViewport(active.sessionId, W1);
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 1, y: 2, zoom: 1 }), { code: 'PERMISSION_DENIED' });
});

test('an external workspace replacement conflicts with a pending viewport and preserves external bytes', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'canvas-conflict');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active; const base = await manager.loadCanvasWorkspace(active.sessionId, W1);
  await manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 7.125, y: -8.5, zoom: 1.25 });
  const file = pathOf(root, W1); const external = JSON.parse(await readFile(file, 'utf8'));
  external.revision++; external.name = 'External revision'; const bytes = Buffer.from(JSON.stringify(external) + '\n'); await writeFile(file, bytes);
  await assert.rejects(manager.flushCanvasWorkspace(active.sessionId, W1));
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await manager.getState()).active.pendingViewport, true);
  await manager.discardCanvasViewport(active.sessionId, W1);
});

test('A3-004/006: placements share live entity content but move and resize independently, then reopen exactly', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'canvas-placement-projection');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let extraLease;
  t.after(async () => { await extraLease?.close(); });
  const active = (await manager.openFolder(root)).active;
  let first = await manager.loadCanvasWorkspace(active.sessionId, W1);
  let second = await manager.loadCanvasWorkspace(active.sessionId, W2);
  const firstPlacement = first.placements.find((placement) => placement.entityId === E1);
  const secondPlacement = second.placements.find((placement) => placement.entityId === E1);
  assert.ok(firstPlacement && secondPlacement);
  assert.notEqual(firstPlacement.id, secondPlacement.id);
  assert.equal(first.entities.find((entity) => entity.id === E1).id, second.entities.find((entity) => entity.id === E1).id);
  assert.equal(first.entities.find((entity) => entity.id === E1).title, 'Visión');
  assert.equal(first.entities.find((entity) => entity.id === E1).typeAvailable, true, 'the built-in Markdown page renderer is available');
  assert.ok(first.entities.find((entity) => entity.id === E1).ports);

  // Update canonical Markdown through the existing validated writer.
  const leaseResult = await openProjectService(root, { host });
  assert.equal(leaseResult.ok, true);
  extraLease = leaseResult.value;
  const opened = await extraLease.service.openResource(R1);
  assert.equal(opened.ok, true);
  const changedText = '# Visión revisada\n\nLa misma entidad se representa en dos workspaces.\n';
  const proposal = await extraLease.service.prepareResourceWrite({ operationId: '8f4e5577-88b0-4fc6-8a77-885f32b19449', resourceId: R1,
    expectedRevision: opened.value.revision, expectedHash: opened.value.sha256, bytes: Buffer.from(changedText, 'utf8') });
  assert.equal(proposal.ok, true, proposal.diagnostics?.map((item) => item.message).join('\n'));
  const written = await extraLease.service.commit(proposal.value);
  assert.equal(written.ok, true, written.diagnostics?.map((item) => item.message).join('\n'));
  await extraLease.close(); extraLease = undefined;
  assert.equal((await manager.loadCanvasContent(active.sessionId, W1, E1, R1)).text, changedText);
  assert.equal((await manager.loadCanvasContent(active.sessionId, W2, E1, R1)).text, changedText);

  first = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const moved = await manager.updateCanvasPlacement(active.sessionId, W1, firstPlacement.id, firstPlacement.revision, {
    position: { x: 730.25, y: -112.5 }, size: { width: 480, height: 310 }, style: { 'a3.ui.accent': '#78a9d1' }
  });
  const movedPlacement = moved.placements.find((placement) => placement.id === firstPlacement.id);
  const untouched = (await manager.loadCanvasWorkspace(active.sessionId, W2)).placements.find((placement) => placement.id === secondPlacement.id);
  assert.deepEqual(movedPlacement.position, { x: 730.25, y: -112.5 });
  assert.deepEqual(movedPlacement.size, { width: 480, height: 310 });
  assert.equal(movedPlacement.style['a3.ui.accent'], '#78a9d1');
  assert.deepEqual(untouched.position, secondPlacement.position);
  assert.deepEqual(untouched.size, secondPlacement.size);

  second = await manager.loadCanvasWorkspace(active.sessionId, W2);
  const created = await manager.createCanvasPlacement(active.sessionId, W2, second.revision, E1, { x: 2000.125, y: -2500.5 });
  const newPlacement = created.placements.find((placement) => !second.placements.some((old) => old.id === placement.id));
  assert.ok(newPlacement);
  assert.equal(newPlacement.entityId, E1);
  assert.deepEqual(newPlacement.size, { width: 300, height: 190 });

  await manager.closeActive(active.sessionId);
  const reopenedProject = (await manager.openFolder(root)).active;
  const reopenedFirst = await manager.loadCanvasWorkspace(reopenedProject.sessionId, W1);
  const reopenedSecond = await manager.loadCanvasWorkspace(reopenedProject.sessionId, W2);
  assert.deepEqual(reopenedFirst.placements.find((placement) => placement.id === firstPlacement.id), movedPlacement);
  assert.deepEqual(reopenedSecond.placements.find((placement) => placement.id === newPlacement.id), newPlacement);
  assert.equal(reopenedSecond.entities.find((entity) => entity.id === E1).title, 'Visión');
  assert.equal((await manager.loadCanvasContent(reopenedProject.sessionId, W2, E1, R1)).text, changedText);
});

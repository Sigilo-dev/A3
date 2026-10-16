import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, id, W1, P1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const parameters = { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false };

test('A3-006: one store-owned undo/redo stack persists across project close and reopen', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const placement = canvas.placements.find((item) => item.id === P1), before = structuredClone(placement.position);
  canvas = await manager.moveCanvasPlacements(active.sessionId, W1, [{ id: placement.id, expectedRevision: placement.revision, position: { x: 640.25, y: -180.75 } }]);
  assert.deepEqual(canvas.placements.find((item) => item.id === P1).position, { x: 640.25, y: -180.75 });
  assert.equal(canvas.history.canUndo, true); assert.equal(canvas.history.canRedo, false);
  assert.equal(canvas.history.undoRequiresDelete, false); assert.equal(canvas.history.deleteAvailable, false);
  await manager.closeActive(active.sessionId);
  active = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.equal(canvas.history.canUndo, true); assert.equal(canvas.history.canRedo, false);
  canvas = await manager.undoCanvas(active.sessionId, W1);
  assert.deepEqual(canvas.placements.find((item) => item.id === P1).position, before);
  assert.equal(canvas.history.canUndo, false); assert.equal(canvas.history.canRedo, true);
  canvas = await manager.redoCanvas(active.sessionId, W1);
  assert.deepEqual(canvas.placements.find((item) => item.id === P1).position, { x: 640.25, y: -180.75 });
  assert.equal(canvas.history.canUndo, true); assert.equal(canvas.history.canRedo, false);
  assert.ok((await readdir(join(tempRoot, 'catalog', 'canvas-history'))).some((name) => name.endsWith('.json')),
    'history is owned by the host store and lives outside portable project files');
});

test('A3-005–007: batch alignment, layer order and lock state persist and undo/redo with fresh revisions', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active, canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  if (canvas.placements.length < 3) {
    canvas = await manager.createCanvasPlacement(active.sessionId, W1, canvas.revision, canvas.entityChoices[0].id, { x: 900, y: 510 });
  }
  const selected = canvas.placements.slice(0, 3), before = structuredClone(selected);
  const left = Math.min(...selected.map((item) => item.position.x));
  const top = Math.min(...selected.map((item) => item.position.y));
  canvas = await manager.updateCanvasPlacementViews(active.sessionId, W1, selected.map((item, index) => ({ id: item.id, expectedRevision: item.revision,
    position: { x: left, y: top + index * 180 }, style: { 'a3.ui.z-index': 20 + index, ...(index === 2 ? { 'a3.ui.locked': true } : {}) } })));
  const arranged = selected.map((item) => canvas.placements.find((next) => next.id === item.id));
  assert.ok(arranged.every((item) => item.position.x === left));
  assert.deepEqual(arranged.map((item) => item.style['a3.ui.z-index']), [20, 21, 22]);
  assert.equal(arranged[2].style['a3.ui.locked'], true);
  await assert.rejects(manager.moveCanvasPlacements(active.sessionId, W1, [{ id: arranged[2].id, expectedRevision: arranged[2].revision, position: { x: 400, y: 400 } }]),
    (error) => error.code === 'VALIDATION_FAILED' && error.message.includes('Desbloquea'));
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).placements.find((item) => item.id === arranged[2].id).position.x, left);
  await manager.closeActive(active.sessionId);
  active = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.equal(canvas.history.canUndo, true);
  canvas = await manager.undoCanvas(active.sessionId, W1);
  for (const old of before) {
    const restored = canvas.placements.find((item) => item.id === old.id);
    assert.deepEqual(restored.position, old.position); assert.deepEqual(restored.style, old.style);
    assert.ok(restored.revision > old.revision);
  }
  canvas = await manager.redoCanvas(active.sessionId, W1);
  assert.deepEqual(selected.map((item) => canvas.placements.find((next) => next.id === item.id).position), arranged.map((item) => item.position));
  assert.deepEqual(selected.map((item) => canvas.placements.find((next) => next.id === item.id).style['a3.ui.z-index']), [20, 21, 22]);
});

test('A3-005–007: duplicate group/drawing and graph content with reversible IDs and resource bytes', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active, canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const first = canvas.placements[0], second = canvas.placements[1]; assert.ok(first && second);
  canvas = await manager.createCanvasDrawing(active.sessionId, W1, canvas.revision, [{ x: 10, y: 15, pressure: 0.6 }, { x: 24, y: 31, pressure: 0.9 }], parameters,
    { 'future.keep': { source: 'test' } });
  const originalDrawing = canvas.drawings[0];
  canvas = await manager.createCanvasGroup(active.sessionId, W1, canvas.revision, 'Principal', [
    { kind: 'placement', id: first.id }, { kind: 'drawing', id: originalDrawing.id }
  ]);
  const parent = canvas.groups.find((group) => group.name === 'Principal'); assert.ok(parent);
  canvas = await manager.createCanvasGroup(active.sessionId, W1, canvas.revision, 'Subgrupo', [{ kind: 'placement', id: second.id }]);
  const child = canvas.groups.find((group) => group.name === 'Subgrupo'); assert.ok(child);
  const parentAfterChild = canvas.groups.find((group) => group.id === parent.id);
  canvas = await manager.setCanvasGroupMembers(active.sessionId, W1, parentAfterChild.id, parentAfterChild.revision,
    [...parentAfterChild.members, { kind: 'group', id: child.id }]);
  const sourceRelationFiles = await readdir(join(root, '.a3/relations'));
  const sourceEntity = canvas.entities.find((entity) => entity.id === first.entityId); assert.ok(sourceEntity?.contentResourceId);
  const originalResource = JSON.parse(await readFile(join(root, '.a3/resources', `${sourceEntity.contentResourceId}.json`), 'utf8'));
  const contentPath = originalResource.path;
  const selected = {
    placements: [], drawings: [], groups: [{ id: parent.id, expectedRevision: canvas.groups.find((group) => group.id === parent.id).revision }]
  };
  canvas = await manager.duplicateCanvasSelection(active.sessionId, W1, canvas.revision, selected, 'representation');
  const duplicateDrawing = canvas.drawings.find((item) => item.id !== originalDrawing.id), duplicateParent = canvas.groups.find((item) => item.id !== parent.id && item.name === 'Principal');
  assert.ok(duplicateDrawing && duplicateParent);
  assert.notEqual(duplicateDrawing.id, originalDrawing.id);
  assert.deepEqual(duplicateDrawing.points, [{ x: 50, y: 55, pressure: 0.6 }, { x: 64, y: 71, pressure: 0.9 }]);
  assert.deepEqual(duplicateDrawing.style, originalDrawing.style);
  const addedRepresentations = canvas.placements.filter((item) => item.id !== first.id && item.id !== second.id);
  assert.ok(addedRepresentations.length >= 2 && addedRepresentations.every((item) => [first.entityId, second.entityId].includes(item.entityId)),
    'representation duplication creates placements while retaining the selected entityIds');
  await manager.closeActive(active.sessionId);
  active = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.equal(canvas.history.undoRequiresDelete, true);
  await assert.rejects(manager.undoCanvas(active.sessionId, W1), { code: 'PERMISSION_DENIED' });
  canvas = await manager.approveCanvasHistoryDeletion(active.sessionId, W1);
  canvas = await manager.undoCanvas(active.sessionId, W1);
  assert.equal(canvas.groups.some((group) => group.id === duplicateParent.id), false);
  assert.equal(canvas.drawings.some((drawing) => drawing.id === duplicateDrawing.id), false);
  canvas = await manager.redoCanvas(active.sessionId, W1);
  assert.ok(canvas.groups.some((group) => group.id === duplicateParent.id));
  assert.ok(canvas.drawings.some((drawing) => drawing.id === duplicateDrawing.id));

  const originalPlacementA = canvas.placements.find((item) => item.id === first.id), originalPlacementB = canvas.placements.find((item) => item.id === second.id);
  const contentBefore = canvas;
  canvas = await manager.duplicateCanvasSelection(active.sessionId, W1, canvas.revision, {
    placements: [originalPlacementA, originalPlacementB].map((item) => ({ id: item.id, expectedRevision: item.revision })), drawings: [], groups: []
  }, 'content');
  const added = canvas.placements.filter((item) => !contentBefore.placements.some((old) => old.id === item.id));
  assert.equal(added.length, 2);
  assert.ok(added.every((item) => item.entityId !== first.entityId && item.entityId !== second.entityId));
  const relationsAfter = await readdir(join(root, '.a3/relations'));
  assert.equal(relationsAfter.length, sourceRelationFiles.length + 1, 'the relation between selected entities is remapped once');
  const copiedEntity = canvas.entities.find((entity) => added.some((item) => item.entityId === entity.id) && entity.contentResourceId); assert.ok(copiedEntity?.contentResourceId);
  const copiedResource = JSON.parse(await readFile(join(root, '.a3/resources', `${copiedEntity.contentResourceId}.json`), 'utf8'));
  assert.notEqual(copiedResource.path, contentPath);
  assert.deepEqual(await readFile(join(root, copiedResource.path)), await readFile(join(root, contentPath)));
  await manager.closeActive(active.sessionId);
  active = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  canvas = await manager.undoCanvas(active.sessionId, W1);
  assert.equal(canvas.placements.some((item) => added.some((copy) => copy.id === item.id)), false);
  await assert.rejects(readFile(join(root, copiedResource.path)), { code: 'ENOENT' });
  canvas = await manager.redoCanvas(active.sessionId, W1);
  assert.equal(canvas.placements.filter((item) => added.some((copy) => copy.id === item.id)).length, 2);
  assert.deepEqual(await readFile(join(root, copiedResource.path)), await readFile(join(root, contentPath)));
});

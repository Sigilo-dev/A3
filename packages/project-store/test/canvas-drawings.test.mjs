import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, W1, E1 } from './fixture.mjs';
const windows = { skip: process.platform !== 'win32' };
const W2 = '00000000-0000-4000-8000-000000000007';
const P = [{ x: 100.125, y: -42.5, pressure: 0.2 }, { x: 110.75, y: -30.25, pressure: 0.95 }, { x: 125.5, y: -20.125, pressure: 0.7 }];
const parameters = { size: 6.5, thinning: 0.45, smoothing: 0.35, streamline: 0.25, simulatePressure: false };
const technicalBytes = async (root) => Promise.all((await readdir(join(root, '.a3/relations'))).sort().map(async (name) => [name, await readFile(join(root, '.a3/relations', name))]));

test('A3-007: freehand geometry, pressure and parameters save, reopen, edit and delete by workspace command', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); let approve = true;
  const host = await fixtureHost(root, 'freehand-user', 'trabajar', () => approve);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active;
  const initial = await manager.loadCanvasWorkspace(active.sessionId, W1), otherWorkspace = await manager.loadCanvasWorkspace(active.sessionId, W2);
  const relations = await technicalBytes(root), entityPath = join(root, '.a3/entities', `${E1}.json`), entityBytes = await readFile(entityPath);
  assert.deepEqual(initial.drawings, []); assert.deepEqual(otherWorkspace.drawings, []);
  let canvas = await manager.createCanvasDrawing(active.sessionId, W1, initial.revision, P, parameters, {
    'a3.ui.stroke.color': '#c3ed82', 'future.keep': { opaque: true }
  });
  let drawing = canvas.drawings[0]; assert.ok(drawing); assert.equal(drawing.revision, 1);
  const path = join(root, '.a3/workspaces', W1, 'drawings', `${drawing.id}.json`);
  const bytes = await readFile(path), source = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(source.points, P); assert.deepEqual(source.parameters, parameters);
  assert.deepEqual(source.style['future.keep'], { opaque: true }); assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W2)).drawings.length, 0);
  await assert.rejects(manager.updateCanvasDrawing(active.sessionId, W1, drawing.id, drawing.revision + 1, { parameters: { size: 9 } }), { code: 'REVISION_CONFLICT' });
  canvas = await manager.updateCanvasDrawing(active.sessionId, W1, drawing.id, drawing.revision,
    { parameters: { size: 12 }, style: { 'a3.ui.stroke.color': '#78a9d1' } });
  drawing = canvas.drawings.find((item) => item.id === drawing.id);
  assert.equal(drawing.revision, 2); assert.equal(drawing.parameters.size, 12); assert.equal(drawing.style['a3.ui.stroke.color'], '#78a9d1');
  assert.deepEqual(drawing.points, P, 'parameter edits do not replace the vector source with an image');
  await manager.closeActive(active.sessionId); active = (await manager.openFolder(root)).active;
  const reopened = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.deepEqual(reopened.drawings[0], drawing); assert.equal(reopened.canDeleteDrawings, false);
  assert.deepEqual(await technicalBytes(root), relations); assert.deepEqual(await readFile(entityPath), entityBytes);
  const beforeDeniedDelete = await readFile(path);
  await assert.rejects(manager.deleteCanvasDrawing(active.sessionId, W1, drawing.id, drawing.revision), { code: 'PERMISSION_DENIED' });
  approve = false; await assert.rejects(manager.approveCanvasDrawingDeletion(active.sessionId, W1), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(await readFile(path), beforeDeniedDelete, 'a denied delete preserves the vector document');
  approve = true; canvas = await manager.approveCanvasDrawingDeletion(active.sessionId, W1);
  assert.equal(canvas.canDeleteDrawings, true);
  const deleted = await manager.deleteCanvasDrawing(active.sessionId, W1, drawing.id, drawing.revision);
  assert.equal(deleted.drawings.length, 0); await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.deepEqual(await technicalBytes(root), relations); assert.deepEqual(await readFile(entityPath), entityBytes);
  await manager.closeActive(active.sessionId); active = (await manager.openFolder(root)).active;
  assert.deepEqual((await manager.loadCanvasWorkspace(active.sessionId, W1)).drawings, []);
});

test('selected strokes convert to a reusable drawing node with editable vector resource, never a raster snapshot', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'drawing-conversion');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active, before = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const stroke = await manager.createCanvasDrawing(active.sessionId, W1, before.revision,
    [{ x: 411.25, y: -80.75, pressure: 0.25 }, { x: 440.5, y: -58.125, pressure: 0.92 }], parameters,
    { 'a3.ui.stroke.color': '#c3ed82' });
  const source = stroke.drawings[0], converted = await manager.createCanvasDrawingNode(active.sessionId, W1, stroke.revision,
    [{ id: source.id, expectedRevision: source.revision }]);
  assert.equal(converted.drawings.length, 0);
  const placement = converted.placements.find((item) => !stroke.placements.some((old) => old.id === item.id)); assert.ok(placement);
  const node = converted.entities.find((item) => item.id === placement.entityId); assert.equal(node.type, 'a3.core.drawing');
  assert.equal(node.properties['a3.drawing.stroke-count'], 1);
  const descriptor = JSON.parse(await readFile(join(root, '.a3/resources', `${node.contentResourceId}.json`), 'utf8'));
  assert.equal(descriptor.path, `assets/drawings/${node.contentResourceId}.json`); assert.equal(descriptor.mediaType, 'application/vnd.a3.drawing+json');
  const assetBytes = await readFile(join(root, descriptor.path)), asset = JSON.parse(assetBytes.toString('utf8'));
  assert.equal(asset.strokes.length, 1); assert.deepEqual(asset.strokes[0].points, source.points); assert.deepEqual(asset.strokes[0].parameters, parameters);
  assert.ok(!assetBytes.toString('utf8').includes('data:image/'), 'vector source remains the only canonical drawing payload');
  const preview = await manager.loadCanvasContent(active.sessionId, W1, node.id, node.contentResourceId); assert.equal(preview.state, 'ready');
  assert.equal(JSON.parse(preview.text).strokes[0].points[0].pressure, 0.25);
  await manager.closeActive(active.sessionId); active = (await manager.openFolder(root)).active;
  const reopened = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.deepEqual(reopened.drawings, []); assert.ok(reopened.placements.some((item) => item.id === placement.id));
  assert.equal((await manager.loadCanvasContent(active.sessionId, W1, node.id, node.contentResourceId)).state, 'ready');
});

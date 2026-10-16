import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, W1, P1, E1 } from './fixture.mjs';
const windows = { skip: process.platform !== 'win32' };
const P2 = '00000000-0000-4000-8000-000000000010', P3 = '00000000-0000-4000-8000-000000000009';
const technicalBytes = async (root) => Promise.all((await readdir(join(root, '.a3/relations'))).sort().map(async (name) => [name, (await readFile(join(root, '.a3/relations', name))).toString('hex')]));

test('A3-006: visual connection lifecycle persists only workspace documents, round-trips style/waypoints and leaves technical export sources identical', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); let approve = true;
  const host = await fixtureHost(root, 'visual-edge-user', 'trabajar', () => approve);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active;
  const initial = await manager.loadCanvasWorkspace(active.sessionId, W1), beforeTechnical = await technicalBytes(root);
  const entityPath = join(root, '.a3/entities', E1 + '.json'), entityBytes = await readFile(entityPath);
  const created = await manager.createCanvasVisualEdge(active.sessionId, W1, initial.revision, P1, P2);
  const edge = created.visualEdges.find((edge) => !initial.visualEdges.some((old) => old.id === edge.id)); assert.ok(edge);
  const edgePath = join(root, '.a3/workspaces', W1, 'visual-edges', edge.id + '.json');
  assert.equal(JSON.parse(await readFile(edgePath, 'utf8')).sourcePlacementId, P1);
  const updated = await manager.updateCanvasVisualEdge(active.sessionId, W1, edge.id, edge.revision, { sourcePlacementId: P2, targetPlacementId: P1, label: 'Referencia visual',
    waypoints: [{ x: 240.125, y: -71.5 }], style: { 'a3.ui.line.direction': 'both', 'a3.ui.line.color': '#78a9d1', 'future.style': { opaque: true } } });
  const edited = updated.visualEdges.find((item) => item.id === edge.id);
  await assert.rejects(manager.updateCanvasVisualEdge(active.sessionId, W1, edge.id, edge.revision, { label: 'Stale' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(manager.updateCanvasVisualEdge(active.sessionId, W1, edge.id, edited.revision, { targetPlacementId: P3 }), { code: 'PLACEMENT_MISSING' });
  await manager.closeActive(active.sessionId); active = (await manager.openFolder(root)).active;
  const reopened = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.deepEqual(reopened.visualEdges.find((item) => item.id === edge.id), edited);
  assert.equal(reopened.canDeleteEdges, false, 'diagram edit alone does not grant deletion');
  await assert.rejects(manager.deleteCanvasVisualEdge(active.sessionId, W1, edge.id, edited.revision), { code: 'PERMISSION_DENIED' });
  approve = false;
  await assert.rejects(manager.approveCanvasEdgeDeletion(active.sessionId, W1), { code: 'PERMISSION_DENIED' });
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).canDeleteEdges, false);
  assert.deepEqual(JSON.parse(await readFile(edgePath, 'utf8')).style['future.style'], { opaque: true });
  approve = true;
  assert.equal((await manager.approveCanvasEdgeDeletion(active.sessionId, W1)).canDeleteEdges, true);
  const deleted = await manager.deleteCanvasVisualEdge(active.sessionId, W1, edge.id, edited.revision);
  assert.equal(deleted.visualEdges.some((item) => item.id === edge.id), false);
  await assert.rejects(readFile(edgePath), { code: 'ENOENT' });
  assert.deepEqual(await technicalBytes(root), beforeTechnical, 'no visual line is serialized/exported into the canonical technical relation sources');
  assert.deepEqual(await readFile(entityPath), entityBytes);
  await manager.closeActive(active.sessionId); active = (await manager.openFolder(root)).active;
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).visualEdges.some((item) => item.id === edge.id), false);
});

test('selection moves are one revision-checked domain operation; locked nodes, stale and denied proposals never change shared content', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'selection-user');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const original = canvas.placements.find((item) => item.id === P1);
  canvas = await manager.updateCanvasPlacement(active.sessionId, W1, P1, original.revision, { style: { 'a3.ui.locked': true } });
  const locked = canvas.placements.find((item) => item.id === P1), second = canvas.placements.find((item) => item.id === P2);
  await assert.rejects(manager.moveCanvasPlacements(active.sessionId, W1, [
    { id: P2, expectedRevision: second.revision, position: { x: 2000, y: 1000 } }, { id: P1, expectedRevision: locked.revision, position: { x: 10, y: 10 } }
  ]));
  assert.deepEqual((await manager.loadCanvasWorkspace(active.sessionId, W1)).placements.find((item) => item.id === P2), second);
  canvas = await manager.updateCanvasPlacement(active.sessionId, W1, P1, locked.revision, { style: { 'a3.ui.locked': false } });
  const changes = canvas.placements.map((item, index) => ({ id: item.id, expectedRevision: item.revision, position: { x: index * 410.25, y: 150 } }));
  const moved = await manager.moveCanvasPlacements(active.sessionId, W1, changes);
  assert.deepEqual(moved.placements.map((item) => item.position), changes.map((item) => item.position));
  await assert.rejects(manager.moveCanvasPlacements(active.sessionId, W1, changes), { code: 'REVISION_CONFLICT' });
  const expanded = await manager.createCanvasPlacement(active.sessionId, W1, moved.revision, E1, { x: 850, y: 50 });
  const extra = expanded.placements.find((placement) => !moved.placements.some((old) => old.id === placement.id));
  const connected = await manager.createCanvasVisualEdge(active.sessionId, W1, expanded.revision, P1, extra.id.toUpperCase());
  const edge = connected.visualEdges.find((edge) => !expanded.visualEdges.some((old) => old.id === edge.id));
  assert.equal(edge.targetPlacementId, extra.id, 'the projection resolves UUID aliases to the exact React Flow placement ID');
  assert.equal(JSON.parse(await readFile(join(root, '.a3/workspaces', W1, 'visual-edges', edge.id + '.json'), 'utf8')).targetPlacementId, extra.id.toUpperCase(), 'projection never rewrites portable references');
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'diagram.edit' });
  await assert.rejects(manager.createCanvasVisualEdge(active.sessionId, W1, moved.revision, P1, P2), { code: 'PERMISSION_DENIED' });
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).canWrite, false);
});

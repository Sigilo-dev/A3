import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, id, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };

test('E3-A1: conceptual nodes and relation views go through the project writer and reopen without becoming visual edges', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'conceptual-diagram');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const opened = await manager.openFolder(root); const sessionId = opened.active.sessionId;
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'delete', mode: 'direct' });
  let canvas = await manager.loadCanvasWorkspace(sessionId, W1);
  const initialVisualEdgeIds = canvas.visualEdges.map((edge) => edge.id);
  const create = async (kind, title, x) => {
    canvas = await manager.createCanvasConceptualNode(sessionId, W1, canvas.revision, kind, title, { x, y: 80 });
    const placement = canvas.placements.find((item) => item.position.x === x && item.position.y === 80);
    assert.ok(placement, `${title} has a persisted placement`);
    const entity = canvas.entities.find((item) => item.id === placement.entityId);
    assert.equal(entity.type, `a3.conceptual.${kind}`); assert.equal(entity.typeAvailable, true);
    return placement;
  };
  const a = await create('concept', 'A', 300), b = await create('idea', 'B', 700), c = await create('question', 'C', 1100);
  const relate = async (from, to, label, kind) => {
    canvas = await manager.createCanvasConceptualRelation(sessionId, W1, canvas.revision, from.id, to.id, label, kind);
    return canvas.conceptualRelations.find((item) => item.label === label);
  };
  const ab = await relate(a, b, 'inspira', 'cause'); await relate(b, c, 'abre', 'dependency'); const ca = await relate(c, a, 'regresa');
  assert.equal(canvas.conceptualRelations.length, 3, 'a cycle is accepted for a conceptual diagram');
  assert.deepEqual(canvas.visualEdges.map((edge) => edge.id), initialVisualEdgeIds, 'semantic RelationViews never enter VisualEdge');
  assert.ok(ab && ca);
  const nodeA = canvas.entities.find((entity) => entity.id === a.entityId);
  canvas = await manager.updateCanvasConceptualNode(sessionId, W1, nodeA.id, nodeA.revision, { kind: 'decision', title: 'A revisado' });
  assert.equal(canvas.entities.find((entity) => entity.id === a.entityId).type, 'a3.conceptual.decision');
  canvas = await manager.updateCanvasConceptualRelation(sessionId, W1, ab.relationId, ab.relationRevision, { label: 'justifica', kind: null });
  assert.equal(canvas.conceptualRelations.find((item) => item.relationId === ab.relationId).label, 'justifica');
  await assert.rejects(manager.updateCanvasConceptualRelation(sessionId, W1, ab.relationId, ab.relationRevision, { label: 'stale' }), (error) => error.code === 'REVISION_CONFLICT');
  const updatedRelation = canvas.conceptualRelations.find((item) => item.relationId === ab.relationId);
  canvas = await manager.deleteCanvasConceptualRelation(sessionId, W1, updatedRelation.relationId, updatedRelation.relationRevision);
  assert.equal(canvas.conceptualRelations.length, 2); assert.deepEqual(canvas.visualEdges.map((edge) => edge.id), initialVisualEdgeIds);
  const relationJson = JSON.parse(await readFile(join(root, '.a3', 'relations', `${ca.relationId}.json`), 'utf8'));
  const viewJson = JSON.parse(await readFile(join(root, '.a3', 'workspaces', W1, 'relation-views', `${ca.id}.json`), 'utf8'));
  assert.equal(relationJson.type, 'a3.conceptual.relationship'); assert.equal(viewJson.relationId, ca.relationId);
  await manager.closeActive(sessionId);
  const reopened = await manager.openFolder(root); canvas = await manager.loadCanvasWorkspace(reopened.active.sessionId, W1);
  assert.equal(canvas.conceptualRelations.length, 2); assert.equal(canvas.conceptualRelations.some((item) => item.label === 'regresa'), true);
  assert.deepEqual(canvas.visualEdges.map((edge) => edge.id), initialVisualEdgeIds);
});

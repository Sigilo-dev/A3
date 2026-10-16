import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { projectUmlCanvas } from '../dist/uml-canvas.js';
import { scratch, fixtureHost, W1 } from './fixture.mjs';
import { elementData, relationshipData } from '../../../fixtures/e3/uml/resolve.mjs';

const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e3/uml/scenario.json', import.meta.url), 'utf8'));
const W2 = '00000000-0000-4000-8000-000000000007';
test('projection does not interpret unknown UML versions or mutate preserved properties', () => {
  const entity = { kind: 'entity', value: { id: 'id', revision: 4, title: 'future', type: 'a3.uml.class', typeVersion: '2.0.0', properties: { 'a3.uml': { future: 'keep' } } } };
  const original = structuredClone(entity), projected = projectUmlCanvas({ records: [entity] }, W1);
  assert.deepEqual(projected, { elements: [], relationships: [], relationViews: [] }); assert.deepEqual(entity, original);
});

test('A3-013 subset: UML fixture persists through host writer, shared views, history, revisions and reopen on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'uml-user');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let sessionId = (await manager.openFolder(root)).active.sessionId;
  const elements = {}, placements = {}, relationships = {};
  const apply = async (ws, operation) => {
    const canvas = await manager.loadCanvasWorkspace(sessionId, ws);
    return manager.changeCanvasUml(sessionId, ws, canvas.revision, operation);
  };
  const sourcePath = join(root, 'pages', 'readme.md');
  const original = await readFile(sourcePath);
  for (const [i, e] of scenario.elements.entries()) {
    const canvas = await apply(W1, { action: 'create-element', kind: e.kind, title: e.title, data: elementData(e, elements), position: { x: i * 400, y: 50 } });
    elements[e.key] = canvas.uml.elements.find((item) => item.title === e.title).id; placements[e.key] = canvas.placements.find((p) => p.entityId === elements[e.key]).id;
  }
  for (const r of scenario.relationships) {
    const canvas = await apply(W1, { action: 'create-relationship', kind: r.kind, sourcePlacementId: placements[r.source], targetPlacementId: placements[r.target], data: relationshipData(r) });
    relationships[r.key] = canvas.uml.relationships.find((item) => item.data.label === r.label).id;
  }
  // Offline edits simulate a newer producer adding opaque namespaced extension fields.
  await manager.closeActive(sessionId);
  const orderFile = join(root, '.a3/entities', `${elements.order}.json`), relFile = join(root, '.a3/relations', `${relationships.state}.json`);
  const offline = JSON.parse(await readFile(orderFile, 'utf8')), relation = JSON.parse(await readFile(relFile, 'utf8'));
  offline.extensions['fixture.future'] = { keep: true }; offline.properties['a3.uml']['fixture.future'] = ['opaque'];
  offline.properties['a3.uml'].attributes[0].type['fixture.future'] = { keep: 'type' };
  offline.properties['a3.uml'].methods[0].parameters[0]['fixture.future'] = { keep: 'parameter' };
  relation.properties['a3.uml'].source.multiplicity['fixture.future'] = 'bounds';
  await writeFile(orderFile, JSON.stringify(offline)); await writeFile(relFile, JSON.stringify(relation));
  sessionId = (await manager.openFolder(root)).active.sessionId;
  let canvas = await manager.loadCanvasWorkspace(sessionId, W1); assert.equal(canvas.uml.relationViews.length, 6);
  assert.equal(canvas.visualEdges.length, 1, 'fixture visual edge is independent');
  const workspaceBytes = await readFile(join(root, '.a3/workspaces', W1, 'workspace.json'));
  for (const key of ['order', 'status']) await apply(W2, { action: 'show-element', entityId: elements[key], position: { x: key === 'order' ? 0 : 400, y: 400 } });
  let second = await manager.loadCanvasWorkspace(sessionId, W2);
  const reused = await apply(W2, { action: 'show-relationship', relationId: relationships.state, sourcePlacementId: second.placements.find((p) => p.entityId === elements.order).id, targetPlacementId: second.placements.find((p) => p.entityId === elements.status).id });
  assert.equal(reused.uml.relationViews.find((r) => r.relationId === relationships.state).data.target.role, 'estado');
  const order = reused.uml.elements.find((e) => e.id === elements.order);
  const attributes = structuredClone(order.data.attributes), methods = structuredClone(order.data.methods);
  delete attributes[0].type['fixture.future']; delete methods[0].parameters[0]['fixture.future'];
  canvas = await apply(W2, { action: 'update-element', entityId: order.id, expectedRevision: order.revision, title: 'Pedido compartido', data: { constraints: ['total > 0'], attributes, methods } });
  assert.equal((await manager.loadCanvasWorkspace(sessionId, W1)).entities.find((e) => e.id === order.id).title, 'Pedido compartido');
  await assert.rejects(apply(W2, { action: 'update-element', entityId: order.id, expectedRevision: order.revision, title: 'stale', data: {} }), (e) => e.code === 'REVISION_CONFLICT');
  await manager.undoCanvas(sessionId, W2); assert.equal((await manager.loadCanvasWorkspace(sessionId, W1)).entities.find((e) => e.id === order.id).title, 'Pedido');
  await manager.redoCanvas(sessionId, W2);
  const entityPath = join(root, '.a3/entities', `${elements.order}.json`), bytes = await readFile(entityPath);
  const relationPath = join(root, '.a3/relations', `${relationships.state}.json`), relBytes = await readFile(relationPath);
  const beforeW1 = (await manager.loadCanvasWorkspace(sessionId, W1)).placements.find((p) => p.entityId === order.id).position;
  second = await manager.loadCanvasWorkspace(sessionId, W2); const placement = second.placements.find((p) => p.entityId === order.id);
  await manager.updateCanvasPlacement(sessionId, W2, placement.id, placement.revision, { position: { x: -20, y: 900 } });
  await manager.closeActive(sessionId); sessionId = (await manager.openFolder(root)).active.sessionId;
  const reopened = await manager.loadCanvasWorkspace(sessionId, W2), data = reopened.uml.elements.find((e) => e.id === order.id).data;
  assert.equal(data.attributes[0].type.entityId, elements.status); assert.equal(data.methods[0].parameters[0].type.entityId, elements.status);
  assert.deepEqual(data.constraints, ['total > 0']); assert.equal(reopened.uml.relationViews.find((r) => r.relationId === relationships.state).data.source.multiplicity.upper, '*');
  assert.deepEqual(data['fixture.future'], ['opaque']); assert.deepEqual(data.attributes[0].type['fixture.future'], { keep: 'type' });
  assert.deepEqual(data.methods[0].parameters[0]['fixture.future'], { keep: 'parameter' });
  assert.deepEqual(JSON.parse(bytes).extensions['fixture.future'], { keep: true });
  assert.equal(JSON.parse(relBytes).properties['a3.uml'].source.multiplicity['fixture.future'], 'bounds');
  assert.equal(reopened.placements.find((p) => p.id === placement.id).position.y, 900);
  assert.deepEqual((await manager.loadCanvasWorkspace(sessionId, W1)).placements.find((p) => p.entityId === order.id).position, beforeW1);
  assert.deepEqual(await readFile(entityPath), bytes); assert.deepEqual(await readFile(relationPath), relBytes);
  assert.deepEqual(await readFile(join(root, '.a3/workspaces', W1, 'workspace.json')), workspaceBytes);
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'diagram.edit' });
  const current = reopened.uml.elements.find((e) => e.id === order.id);
  await assert.rejects(apply(W2, { action: 'update-element', entityId: order.id, expectedRevision: current.revision, title: 'forbidden', data: {} }), (e) => e.code === 'PERMISSION_DENIED');
  assert.deepEqual(await readFile(entityPath), bytes); assert.deepEqual(await readFile(sourcePath), original);
});

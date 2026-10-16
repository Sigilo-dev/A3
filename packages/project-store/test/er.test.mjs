import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, W1 } from './fixture.mjs';
import { projectErCanvas } from '../dist/er-canvas.js';
import { resolvedTableData, relationshipData } from '../../../fixtures/e3/er/resolve.mjs';

const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e3/er/scenario.json', import.meta.url), 'utf8'));
const W2 = '00000000-0000-4000-8000-000000000007';

test('ER projection filters types/versions and does not mutate future documents', () => {
  const entity = { kind: 'entity', value: { id: 'id', revision: 4, title: 'future', type: 'a3.er.table', typeVersion: '2.0.0', properties: { 'a3.er': { future: 'keep' } } } };
  const original = structuredClone(entity), projected = projectErCanvas({ records: [entity] }, W1);
  assert.deepEqual(projected, { elements: [], relationships: [], relationViews: [] }); assert.deepEqual(entity, original);
});

test('A3-013 subset: ER editing validates, preserves opaque IDs, reopens and shares entity tables across workspace placements', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'er-user');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let sessionId = (await manager.openFolder(root)).active.sessionId;
  const tables = {}, placements = {}, relations = {};
  const apply = async (workspaceId, operation) => {
    const canvas = await manager.loadCanvasWorkspace(sessionId, workspaceId);
    return manager.changeCanvasEr(sessionId, workspaceId, canvas.revision, operation);
  };
  const sourcePath = join(root, 'pages', 'readme.md'), sourceBytes = await readFile(sourcePath);
  for (const [i, table] of scenario.tables.entries()) {
    const canvas = await apply(W1, { action: 'create-table', title: table.title, data: resolvedTableData(table, tables, scenario), position: { x: i * 420, y: 50 } });
    tables[table.key] = canvas.er.elements.find((entry) => entry.title === table.title).id;
    placements[table.key] = canvas.placements.find((entry) => entry.entityId === tables[table.key]).id;
  }
  for (const relationship of scenario.relationships) {
    const canvas = await apply(W1, { action: 'create-relationship', sourcePlacementId: placements[relationship.source], targetPlacementId: placements[relationship.target], data: relationshipData(relationship) });
    relations[relationship.key] = canvas.er.relationships.find((entry) => entry.data.label === relationship.label).id;
  }
  const initial = await manager.loadCanvasWorkspace(sessionId, W1);
  assert.equal(initial.er.elements.length, 2); assert.equal(initial.er.relationViews.length, 1);
  assert.equal(initial.er.elements.find((entry) => entry.id === tables.order).data.fields[1].foreignKey.fieldId, scenario.tables[0].fields[0].id);
  const persistedEntityPath = join(root, '.a3/entities', `${tables.order}.json`), persistedRelationPath = join(root, '.a3/relations', `${relations.customerOrders}.json`);
  await manager.closeActive(sessionId);

  // Simulate a newer producer writing namespaced metadata unknown to this version.
  const orderDocument = JSON.parse(await readFile(persistedEntityPath, 'utf8'));
  orderDocument.extensions['fixture.future'] = { keep: true };
  orderDocument.properties['a3.er'].futureTableMetadata = { keep: 'table' };
  orderDocument.properties['a3.er'].fields[0].futureFieldMetadata = ['opaque'];
  await writeFile(persistedEntityPath, JSON.stringify(orderDocument));
  const relationDocument = JSON.parse(await readFile(persistedRelationPath, 'utf8'));
  relationDocument.properties['a3.er'].futureRelationMetadata = { keep: true };
  await writeFile(persistedRelationPath, JSON.stringify(relationDocument));
  sessionId = (await manager.openFolder(root)).active.sessionId;
  let canvas = await manager.loadCanvasWorkspace(sessionId, W1);
  const workspaceBytes = await readFile(join(root, '.a3/workspaces', W1, 'workspace.json'));
  const customer = canvas.er.elements.find((entry) => entry.id === tables.customer);
  const existing = await apply(W2, { action: 'show-table', entityId: customer.id, position: { x: 1000, y: 450 } });
  const secondPlacement = existing.placements.find((entry) => entry.entityId === customer.id);
  assert.ok(secondPlacement); assert.notEqual(secondPlacement.id, placements.customer);
  const renamedField = structuredClone(customer.data.fields[0]); renamedField.name = 'customer_key';
  canvas = await apply(W2, { action: 'update-table', entityId: customer.id, expectedRevision: customer.revision, title: 'Buyer', data: { fields: [renamedField, ...customer.data.fields.slice(1)] } });
  assert.equal((await manager.loadCanvasWorkspace(sessionId, W1)).er.elements.find((entry) => entry.id === customer.id).title, 'Buyer');
  assert.equal(canvas.er.elements.find((entry) => entry.id === tables.order).data.fields[1].foreignKey.fieldId, renamedField.id);
  await assert.rejects(apply(W2, { action: 'update-table', entityId: customer.id, expectedRevision: customer.revision, title: 'stale', data: {} }), (error) => error.code === 'REVISION_CONFLICT');
  await manager.closeActive(sessionId); sessionId = (await manager.openFolder(root)).active.sessionId;
  const reopened = await manager.loadCanvasWorkspace(sessionId, W2), reopenedPrimary = await manager.loadCanvasWorkspace(sessionId, W1), buyer = reopened.er.elements.find((entry) => entry.id === customer.id);
  assert.equal(buyer.title, 'Buyer'); assert.equal(buyer.data.fields[0].name, 'customer_key');
  assert.equal(reopenedPrimary.er.relationViews.find((entry) => entry.relationId === relations.customerOrders).data.targetCardinality, 'zero-or-many');
  const opaque = JSON.parse(await readFile(persistedEntityPath, 'utf8')), opaqueRelation = JSON.parse(await readFile(persistedRelationPath, 'utf8'));
  assert.deepEqual(opaque.extensions['fixture.future'], { keep: true });
  assert.deepEqual(opaque.properties['a3.er'].futureTableMetadata, { keep: 'table' });
  assert.deepEqual(opaque.properties['a3.er'].fields[0].futureFieldMetadata, ['opaque']);
  assert.deepEqual(opaqueRelation.properties['a3.er'].futureRelationMetadata, { keep: true });
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.deepEqual(await readFile(join(root, '.a3/workspaces', W1, 'workspace.json')), workspaceBytes);
  assert.deepEqual(reopened.er.elements.map((entry) => entry.id).sort(), Object.values(tables).sort());
});

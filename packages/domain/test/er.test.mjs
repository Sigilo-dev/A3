import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { defaultRegistry, exportMermaidEr, erData, erTable, prepareCommand, validateSnapshot } from '../dist/src/index.js';
import { context, fixture, find, id, request, success, rejection, W1, W2 } from './fixture.mjs';
import { resolvedTableData, relationshipData } from '../../../fixtures/e3/er/resolve.mjs';

const scenario = JSON.parse(readFileSync(new URL('../../../fixtures/e3/er/scenario.json', import.meta.url), 'utf8'));
let serial = 13000;
function change(state, workspaceId, operation, accept = true) {
  const ids = Object.fromEntries(['entityId', 'placementId', 'relationId', 'relationViewId'].map((key) => [key, id(++serial)])), refs = [];
  if (operation.action === 'create-table') refs.push({ kind: 'entity', id: ids.entityId });
  if (['create-table', 'show-table'].includes(operation.action)) refs.push({ kind: 'placement', id: ids.placementId, workspaceId });
  if (operation.action === 'create-relationship') refs.push({ kind: 'relation', id: ids.relationId });
  if (['create-relationship', 'show-relationship'].includes(operation.action)) refs.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId });
  const req = request(state, 'a3.er.change', { workspaceId, operation, ids }, refs); req.scope.entityIds.push(ids.entityId);
  const result = prepareCommand(state, req, context()); return { result, ids, state: accept ? success(result).nextSnapshot : state };
}
function build() {
  let state = fixture(); const tables = {}, placements = {};
  for (const [i, entry] of scenario.tables.entries()) {
    const next = change(state, W1, { action: 'create-table', title: entry.title, data: resolvedTableData(entry, tables, scenario), position: { x: i * 420, y: 80 } });
    state = next.state; tables[entry.key] = next.ids.entityId; placements[entry.key] = next.ids.placementId;
  }
  const relations = {};
  for (const entry of scenario.relationships) {
    const next = change(state, W1, { action: 'create-relationship', sourcePlacementId: placements[entry.source], targetPlacementId: placements[entry.target], data: relationshipData(entry) });
    state = next.state; relations[entry.key] = next.ids.relationId;
  }
  return { state, tables, placements, relations };
}
const built = build();

test('A3-013 ER family stores tables, nullable/typed fields, primary/foreign/unique keys and cardinality independently of UML', () => {
  const { state, tables, relations } = built, customer = erData(find(state, 'entity', tables.customer).value), order = erData(find(state, 'entity', tables.order).value);
  assert.deepEqual(validateSnapshot(state, defaultRegistry()).filter((d) => d.severity === 'error'), []);
  assert.equal(erTable(find(state, 'entity', tables.customer).value), true);
  assert.deepEqual(customer.fields.map((f) => [f.name, f.type, f.nullable, f.primaryKey, f.unique]), [
    ['id', 'INTEGER', false, true, false], ['codigo', 'VARCHAR(40)', false, false, true], ['nombre', 'VARCHAR(120)', true, false, false]
  ]);
  assert.deepEqual(order.fields[1].foreignKey, { tableId: tables.customer, fieldId: scenario.tables[0].fields[0].id });
  assert.equal(find(state, 'relation', relations.customerOrders).value.type, 'a3.er.relationship');
  assert.equal(state.records.filter((r) => r.kind === 'visual-edge').length, fixture().records.filter((r) => r.kind === 'visual-edge').length);
  assert.ok(!Object.values(tables).some((tableId) => find(state, 'entity', tableId).value.type.startsWith('a3.uml.')));
});

test('table/field renames keep foreign-key and Relation endpoint IDs; a second workspace reuses the same tables', () => {
  const { state, tables, relations, placements } = built, customer = find(state, 'entity', tables.customer).value;
  const reuse = change(state, W2, { action: 'show-table', entityId: tables.customer, position: { x: 900, y: 300 } });
  const field = structuredClone(erData(customer).fields[0]); field.name = 'customer_key';
  const updated = change(reuse.state, W2, { action: 'update-table', entityId: customer.id, expectedRevision: customer.revision, title: 'Buyer', data: { fields: [field, ...erData(customer).fields.slice(1)] } });
  const after = erData(find(updated.state, 'entity', tables.order).value);
  assert.equal(find(updated.state, 'relation', relations.customerOrders).value.source.entityId, tables.customer);
  assert.deepEqual(after.fields[1].foreignKey, { tableId: tables.customer, fieldId: field.id });
  assert.equal(find(updated.state, 'placement', placements.customer, W1).value.position.x, find(state, 'placement', placements.customer, W1).value.position.x);
  assert.ok(validateSnapshot(updated.state, defaultRegistry()).every((d) => d.severity !== 'error'));
});

test('ER validation rejects nullable primary keys, duplicate fields, missing/invalid foreign keys, and accepts cyclic relationships', () => {
  const { state, tables, placements } = built, order = find(state, 'entity', tables.order).value;
  const rejectTable = (data, detail) => rejection(change(state, W1, { action: 'update-table', entityId: order.id, expectedRevision: order.revision, title: order.title, data }, false).result, detail);
  const fields = structuredClone(erData(order).fields); fields[0].nullable = true; rejectTable({ fields }, 'er-primary-nullable');
  const duplicate = [...structuredClone(erData(order).fields), structuredClone(erData(order).fields[0])]; rejectTable({ fields: duplicate }, 'er-field-id-duplicate');
  const missing = structuredClone(erData(order).fields); missing[1].foreignKey.fieldId = id(99999); rejectTable({ fields: missing }, 'er-foreign-key-target-missing');
  const invalidTarget = structuredClone(erData(order).fields); invalidTarget[1].foreignKey.fieldId = scenario.tables[0].fields[2].id; rejectTable({ fields: invalidTarget }, 'er-foreign-key-target-not-key');
  const impossible = structuredClone(erData(order).fields); impossible[1].foreignKey = { tableId: id(99998), fieldId: id(99997) }; assert.equal(change(state, W1,
    { action: 'update-table', entityId: order.id, expectedRevision: order.revision, title: order.title, data: { fields: impossible } }, false).result.ok, false);
  const reverse = change(state, W1, { action: 'create-relationship', sourcePlacementId: placements.order, targetPlacementId: placements.customer,
    data: { label: 'returns', sourceCardinality: 'zero-or-many', targetCardinality: 'one', identifying: false } });
  assert.ok(reverse.result.ok, 'ER relationships can form cycles when the model allows them');
});

test('Mermaid ER export retains types, nullability, PK/FK/UK, stable reference comments and admitted cardinalities', () => {
  const { state, tables } = built, elements = Object.values(tables).map((entityId) => { const entity = find(state, 'entity', entityId).value; return { id: entity.id, title: entity.title, data: erData(entity) }; });
  const relationships = state.records.filter((r) => r.kind === 'relation' && r.value.type === 'a3.er.relationship').map((r) => ({ id: r.value.id, sourceEntityId: r.value.source.entityId,
    targetEntityId: r.value.target.entityId, data: r.value.properties['a3.er'] }));
  const result = exportMermaidEr({ elements, relationships }); assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.match(result.content, /T_Cliente_[0-9a-f]{32}\["Cliente"\] \{/);
  assert.match(result.content, /INTEGER id PK "not null"/); assert.match(result.content, /VARCHAR\(40\) codigo UK "not null"/);
  assert.match(result.content, /VARCHAR\(120\) nombre "nullable"/); assert.match(result.content, /INTEGER cliente_id FK "not null; A3 FK [0-9a-f-]+\.[0-9a-f-]+"/);
  assert.match(result.content, /\|\|\.\.o\{/); assert.match(result.content, new RegExp(`%% A3 relation ${relationships[0].id}`));
  const renamed = { ...elements[0], title: 'Buyer' }, changed = exportMermaidEr({ elements: [renamed, elements[1]], relationships });
  assert.equal(changed.ok, true); assert.match(changed.content, /T_Buyer_[0-9a-f]{32}/); assert.match(changed.content, /%% A3 relation/);
  const bracketType = structuredClone(elements); bracketType[0].data.fields[1].type = 'VARCHAR[40]';
  const typed = exportMermaidEr({ elements: bracketType, relationships }); assert.equal(typed.ok, true); assert.match(typed.content, /VARCHAR\[40\] codigo UK/);
});

test('Mermaid ER export refuses unsafe SQL/identifier fragments and unknown model versions stay in fallback', () => {
  const { tables, state } = built, elements = Object.values(tables).map((entityId) => { const entity = find(state, 'entity', entityId).value; return { id: entity.id, title: entity.title, data: structuredClone(erData(entity)) }; });
  elements[0].data.fields[0].type = 'INTEGER\nADMIN'; elements[0].data.fields[1].name = 'bad name';
  const blocked = exportMermaidEr({ elements, relationships: [] }); assert.equal(blocked.ok, false); assert.equal(blocked.content, ''); assert.equal(blocked.diagnostics.length, 2);
  const future = { schemaVersion: '1.0.0', id: id(99888), revision: 1, type: 'a3.er.table', typeVersion: '2.0.0', title: 'Future', tags: [], ports: [], bindings: {}, extensions: {}, properties: { 'a3.er': { future: true } } };
  assert.equal(erTable(future), false); assert.deepEqual(exportMermaidEr({ elements: [], relationships: [] }), { ok: true, content: 'erDiagram\n', diagnostics: [] });
});

test('ER edits preserve opaque fields by stable member ID and invalid operation does not modify source', () => {
  const { state, tables } = built, entity = find(state, 'entity', tables.customer).value, data = structuredClone(erData(entity));
  data.fields[0].future = { keep: true };
  const req = request(state, 'a3.er.change', { workspaceId: W1, operation: { action: 'update-table', entityId: entity.id, expectedRevision: entity.revision, title: 'Buyer', data: { fields: data.fields } },
    ids: Object.fromEntries(['entityId', 'placementId', 'relationId', 'relationViewId'].map((key) => [key, id(++serial)])) }); req.scope.entityIds.push(entity.id);
  const plan = success(prepareCommand(state, req, context())), updated = erData(find(plan.nextSnapshot, 'entity', entity.id).value);
  assert.deepEqual(updated.fields[0].future, { keep: true }); assert.equal(updated.fields[0].nullable, false); assert.equal(entity.title, 'Cliente');
  const invalid = structuredClone(req); invalid.payload.operation.data.fields[0].nullable = 'no'; rejection(prepareCommand(state, invalid, context()), 'er-command-invalid');
});

test('A3-005 subset: cloned internal ER relation and foreign key target receive cloned table IDs while field IDs remain local and stable', () => {
  const { state, tables, placements } = built, selected = ['customer', 'order'];
  const entities = Object.fromEntries(selected.map((key) => [tables[key], id(++serial)])), newPlacements = Object.fromEntries(selected.map((key) => [placements[key], id(++serial)]));
  const relationIds = Object.fromEntries(Object.values(built.relations).map((relationId) => [relationId, id(++serial)]));
  const relationViewIds = Object.fromEntries(state.records.filter((r) => r.kind === 'relation-view' && r.workspaceId === W1 && relationIds[r.value.relationId])
    .map((r) => [r.value.id, id(++serial)]));
  const payload = { workspaceId: W1, placementIds: selected.map((key) => placements[key]), mode: 'content', offset: { x: 0, y: 600 }, includeExternalRelations: false,
    ids: { entities, placements: newPlacements, relations: relationIds, visualEdges: {}, relationViews: relationViewIds }, resourceCopies: [] };
  const refs = [...Object.values(entities).map((id) => ({ kind: 'entity', id })), ...Object.values(newPlacements).map((id) => ({ kind: 'placement', id, workspaceId: W1 })),
    ...Object.values(relationIds).map((id) => ({ kind: 'relation', id })), ...Object.values(relationViewIds).map((id) => ({ kind: 'relation-view', id, workspaceId: W1 }))];
  const cloned = success(prepareCommand(state, request(state, 'a3.core.duplicate-selection', payload, refs), context())).nextSnapshot;
  const clonedOrder = erData(find(cloned, 'entity', entities[tables.order]).value);
  assert.deepEqual(clonedOrder.fields[1].foreignKey, { tableId: entities[tables.customer], fieldId: scenario.tables[0].fields[0].id });
  const clonedRelation = find(cloned, 'relation', relationIds[built.relations.customerOrders]).value;
  assert.equal(clonedRelation.source.entityId, entities[tables.customer]); assert.equal(clonedRelation.target.entityId, entities[tables.order]);
});

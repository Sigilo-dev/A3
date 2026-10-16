import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { defaultRegistry, prepareCommand, validateSnapshot, umlData, umlKind, umlRelationKind, UML_RELATIONS, validUmlOperation, mergeUmlData, mergeUmlRelation } from '../dist/src/index.js';
import { context, fixture, find, id, request, success, rejection, W1, W2 } from './fixture.mjs';
import { elementData, relationshipData } from '../../../fixtures/e3/uml/resolve.mjs';

const scenario = JSON.parse(readFileSync(new URL('../../../fixtures/e3/uml/scenario.json', import.meta.url), 'utf8'));
let serial = 12000;
function change(state, workspaceId, operation, accept = true) {
  const ids = Object.fromEntries(['entityId', 'placementId', 'relationId', 'relationViewId'].map((key) => [key, id(++serial)]));
  const refs = [];
  if (operation.action === 'create-element') refs.push({ kind: 'entity', id: ids.entityId });
  if (['create-element', 'show-element'].includes(operation.action)) refs.push({ kind: 'placement', id: ids.placementId, workspaceId });
  if (operation.action === 'create-relationship') refs.push({ kind: 'relation', id: ids.relationId });
  if (['create-relationship', 'show-relationship'].includes(operation.action)) refs.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId });
  const req = request(state, 'a3.uml.change', { workspaceId, operation, ids }, refs); req.scope.entityIds.push(ids.entityId);
  const result = prepareCommand(state, req, context());
  return { result, ids, state: accept ? success(result).nextSnapshot : state };
}
function reference() {
  let state = fixture(); const elements = {}, placements = {}, relationships = {};
  for (const [i, e] of scenario.elements.entries()) {
    const next = change(state, W1, { action: 'create-element', kind: e.kind, title: e.title, data: elementData(e, elements), position: { x: i * 400, y: 0 } });
    state = next.state; elements[e.key] = next.ids.entityId; placements[e.key] = next.ids.placementId;
  }
  for (const r of scenario.relationships) {
    const next = change(state, W1, { action: 'create-relationship', kind: r.kind, sourcePlacementId: placements[r.source], targetPlacementId: placements[r.target], data: relationshipData(r) });
    state = next.state; relationships[r.key] = next.ids.relationId;
  }
  return { state, elements, placements, relationships };
}
const built = reference();
test('A3-013 native subset: four classifier/package kinds, full member signatures and six typed relationships use E0 envelopes', () => {
  const { state, elements: e } = built;
  assert.deepEqual(validateSnapshot(state, defaultRegistry()).filter((d) => d.severity === 'error'), []);
  assert.deepEqual(new Set(Object.values(e).map((id) => umlKind(find(state, 'entity', id).value))), new Set(['package', 'class', 'interface', 'enum']));
  const order = umlData(find(state, 'entity', e.order).value);
  assert.equal(order.parentId, e.domain); assert.equal(order.attributes[0].type.entityId, e.status);
  assert.equal(order.methods[0].parameters[0].type.entityId, e.status); assert.equal(order.methods[0].visibility, 'package');
  assert.equal(umlData(find(state, 'entity', e.base).value).abstract, true);
  assert.equal(umlData(find(state, 'entity', e.status).value).literals.length, 2);
  assert.deepEqual(new Set(Object.values(built.relationships).map((id) => umlRelationKind(find(state, 'relation', id).value))), new Set(UML_RELATIONS));
  assert.deepEqual(state.records.filter((r) => r.kind === 'visual-edge'), fixture().records.filter((r) => r.kind === 'visual-edge'));
  const owns = find(state, 'relation', built.relationships.owns).value.properties['a3.uml'];
  assert.equal(owns.source.role, 'pedido'); assert.deepEqual(owns.target.multiplicity, { lower: 1, upper: '*' });
});

test('shared classifier ID has independent placements and revision conflicts fail without mutating the input', () => {
  const { elements: e, placements: p } = built;
  const shown = change(built.state, W2, { action: 'show-element', entityId: e.order, position: { x: -500, y: 22 } });
  const old = find(shown.state, 'entity', e.order).value;
  const updated = change(shown.state, W2, { action: 'update-element', entityId: e.order, expectedRevision: old.revision, title: 'Pedido actualizado', data: { constraints: ['total > 0'] } });
  assert.equal(find(updated.state, 'entity', e.order).value.title, 'Pedido actualizado');
  assert.deepEqual(find(updated.state, 'placement', p.order, W1).value.position, find(built.state, 'placement', p.order, W1).value.position);
  assert.deepEqual(find(updated.state, 'placement', shown.ids.placementId, W2).value.position, { x: -500, y: 22 });
  const failed = change(updated.state, W2, { action: 'update-element', entityId: e.order, expectedRevision: old.revision, title: 'stale', data: {} }, false);
  assert.equal(rejection(failed.result).diagnostics[0].code, 'REVISION_CONFLICT');
  assert.equal(find(built.state, 'entity', e.order).value.title, 'Pedido');
});

test('family validators reject hierarchy cycles, incompatible endpoints, bad bounds and missing references; association cycles remain valid', () => {
  const { elements: e, placements: p } = built;
  const invalidRelation = (kind, source, target, data, detail) => rejection(change(built.state, W1, { action: 'create-relationship', kind, sourcePlacementId: p[source], targetPlacementId: p[target], data: data ?? relationshipData({ label: 'bad' }) }, false).result, detail);
  invalidRelation('generalization', 'base', 'order', undefined, 'uml-generalization-cycle');
  invalidRelation('generalization', 'order', 'contract', undefined, 'uml-generalization-category');
  invalidRelation('realization', 'contract', 'order', undefined, 'uml-realization-category');
  invalidRelation('composition', 'order', 'line', relationshipData({ label: 'bad', sourceUpper: '*' }), 'uml-composite-whole-multiplicity');
  invalidRelation('association', 'order', 'line', { ...relationshipData({ label: 'bad' }), target: { role: '', navigable: false, multiplicity: { lower: 2, upper: 1 } } }, 'uml-command-invalid');
  const update = (entityId, data, detail) => rejection(change(built.state, W1, { action: 'update-element', entityId, expectedRevision: find(built.state, 'entity', entityId).value.revision, title: 'bad', data }, false).result, detail);
  update(e.domain, { parentId: e.domain }, 'uml-package-cycle');
  update(e.order, { parentId: e.line }, 'uml-package-parent');
  const attr = structuredClone(umlData(find(built.state, 'entity', e.order).value).attributes[0]); attr.type.entityId = id(99999);
  update(e.order, { attributes: [attr] }, 'uml-type-reference');
  update(e.order, { attributes: [attr, attr] }, 'uml-member-id-duplicate');
  const valid = change(built.state, W1, { action: 'create-relationship', kind: 'association', sourcePlacementId: p.status, targetPlacementId: p.order, data: relationshipData({ label: 'inverse' }) });
  assert.ok(valid.result.ok);
});

test('edits preserve opaque extension data deeply in members, parameters, type references and association ends', () => {
  const old = structuredClone(umlData(find(built.state, 'entity', built.elements.order).value));
  old.future = { retained: [1, 2] }; old.attributes[0].future = 'attr'; old.attributes[0].type.future = 'type'; old.methods[0].future = 'method';
  old.methods[0].parameters[0].future = 'param'; old.methods[0].parameters[0].type.future = 'paramType';
  const input = structuredClone(old); delete input.attributes[0].future; delete input.attributes[0].type.future; delete input.methods[0].future; delete input.methods[0].parameters[0].future; delete input.methods[0].parameters[0].type.future;
  const merged = mergeUmlData(old, { attributes: input.attributes, methods: input.methods });
  assert.deepEqual(merged, old);
  const data = relationshipData({ label: 'x' }); data.future = 'root'; data.source.future = 'end'; data.source.multiplicity.future = 'bounds';
  assert.deepEqual(mergeUmlRelation(data, relationshipData({ label: 'x' })), data);
});

test('unsupported UML versions and sequence/state/activity cannot be invented by the UML command API', () => {
  for (const kind of ['sequence', 'state', 'activity']) assert.equal(validUmlOperation({ action: 'create-element', kind, title: 'bad', data: {}, position: { x: 0, y: 0 } }), false);
  const state = structuredClone(built.state), entity = find(state, 'entity', built.elements.order).value; entity.typeVersion = '2.0.0';
  assert.equal(umlKind(entity), undefined);
  rejection(change(state, W1, { action: 'update-element', entityId: entity.id, expectedRevision: entity.revision, title: 'bad', data: {} }, false).result, 'uml-element-unavailable');
});

test('A3-005: duplicate content remaps internal package/type/member references and relationships, keeping external inheritance targets', () => {
  const { state, elements: e, placements: p, relationships: r } = built, selected = ['order', 'status', 'domain'];
  const entities = Object.fromEntries(selected.map((key) => [e[key], id(++serial)])), placements = Object.fromEntries(selected.map((key) => [p[key], id(++serial)]));
  const view = state.records.find((v) => v.kind === 'relation-view' && v.value.relationId === r.state);
  const relations = { [r.state]: id(++serial) }, relationViews = { [view.value.id]: id(++serial) };
  const payload = { workspaceId: W1, placementIds: selected.map((key) => p[key]), mode: 'content', offset: { x: 50, y: 50 }, includeExternalRelations: false,
    ids: { entities, placements, relations, relationViews, visualEdges: {} }, resourceCopies: [] };
  const refs = [...Object.values(entities).map((id) => ({ kind: 'entity', id })), ...Object.values(placements).map((id) => ({ kind: 'placement', id, workspaceId: W1 })),
    ...Object.values(relations).map((id) => ({ kind: 'relation', id })), ...Object.values(relationViews).map((id) => ({ kind: 'relation-view', id, workspaceId: W1 }))];
  const next = success(prepareCommand(state, request(state, 'a3.core.duplicate-selection', payload, refs), context())).nextSnapshot;
  const data = umlData(find(next, 'entity', entities[e.order]).value);
  assert.equal(data.parentId, entities[e.domain]); assert.equal(data.attributes[0].type.entityId, entities[e.status]);
  assert.equal(data.methods[0].parameters[0].type.entityId, entities[e.status]);
  assert.equal(data.methods[0].parameters[0].id, umlData(find(state, 'entity', e.order).value).methods[0].parameters[0].id, 'member IDs are local to their classifier');
  assert.equal(find(next, 'relation', relations[r.state]).value.source.entityId, entities[e.order]);
  assert.equal(next.records.filter((v) => v.kind === 'relation' && umlRelationKind(v.value) === 'generalization').length, 1, 'external relations were not duplicated');
});

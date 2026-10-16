import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { c4Category, c4Data, c4View, defaultRegistry, prepareCommand, validateDefinition, validateSnapshot } from '../dist/src/index.js';
import { context, fixture, find, id, request, success, rejection, W1 } from './fixture.mjs';

const scenario = JSON.parse(readFileSync(new URL('../../../fixtures/e3/c4/scenario.json', import.meta.url), 'utf8'));
const registry = { ...defaultRegistry(), nodeTypes: [scenario.customType] }, ctx = context({ registry });
let serial = 2000;
function change(state, workspaceId, operation, accept = true) {
  const ids = Object.fromEntries(['entityId', 'placementId', 'relationId', 'relationViewId', 'diagramId'].map((key) => [key, id(++serial)]));
  const refs = [];
  if (operation.action === 'create-element') refs.push({ kind: 'entity', id: ids.entityId }, { kind: 'placement', id: ids.placementId, workspaceId });
  if (operation.action === 'show-element') refs.push({ kind: 'placement', id: ids.placementId, workspaceId });
  if (operation.action === 'create-relationship') refs.push({ kind: 'relation', id: ids.relationId });
  if (['create-relationship', 'show-relationship'].includes(operation.action)) refs.push({ kind: 'relation-view', id: ids.relationViewId, workspaceId });
  if (operation.action === 'configure-view') {
    const bound = find(state, 'workspace', workspaceId)?.value.properties['a3.c4.diagram-id'];
    if (bound) ids.diagramId = bound; else refs.push({ kind: 'entity', id: ids.diagramId });
    if (operation.newWorkspace) refs.push({ kind: 'workspace', id: workspaceId });
  }
  const req = request(state, 'a3.c4.change', { workspaceId, operation, ids }, refs);
  req.scope.entityIds.push(ids.entityId, ids.diagramId);
  const result = prepareCommand(state, req, ctx);
  return { result, ids, state: accept ? success(result).nextSnapshot : state };
}
function reference() {
  let state = fixture(); const elements = {}, placements = {}, relationships = {}, views = {};
  for (const [index, e] of scenario.elements.entries()) {
    const op = { action: 'create-element', typeName: e.custom ? scenario.customType.name : `a3.c4.${e.category}`, typeVersion: '1.0.0', title: e.title,
      position: { x: index * 350, y: 20 }, data: { description: e.description ?? '', technology: e.technology ?? '', url: e.url ?? '', external: e.external ?? false,
        ...(e.parent ? { parentId: elements[e.parent] } : {}), ...(e.instanceOf ? { instanceOfId: elements[e.instanceOf] } : {}), ...(e.environment ? { environment: e.environment } : {}) } };
    const next = change(state, W1, op); state = next.state; elements[e.key] = next.ids.entityId; placements[e.key] = next.ids.placementId;
  }
  for (const r of scenario.relationships) {
    const next = change(state, W1, { action: 'create-relationship', sourcePlacementId: placements[r.source], targetPlacementId: placements[r.target], description: r.description, protocol: r.protocol });
    state = next.state; relationships[r.key] = next.ids.relationId;
  }
  for (const v of scenario.views) {
    const workspaceId = id(++serial), op = { action: 'configure-view', title: v.title, kind: v.kind, newWorkspace: true, scopeEntityId: elements[v.scope], ...(v.environment ? { environment: v.environment } : {}) };
    let next = change(state, workspaceId, op); state = next.state;
    const view = { workspaceId, diagramId: next.ids.diagramId, placements: {}, relationViews: {} }; views[v.key] = view;
    for (const [index, key] of v.elements.entries()) { next = change(state, workspaceId, { action: 'show-element', entityId: elements[key], position: { x: index * 370, y: 120 } }); state = next.state; view.placements[key] = next.ids.placementId; }
    for (const key of v.relationships) { const r = scenario.relationships.find((r) => r.key === key); next = change(state, workspaceId, { action: 'show-relationship', relationId: relationships[key], sourcePlacementId: view.placements[r.source], targetPlacementId: view.placements[r.target] }); state = next.state; view.relationViews[key] = next.ids.relationViewId; }
    if (v.steps) { const steps = v.steps.map((key, index) => ({ id: id(++serial), order: index + 1, relationViewId: view.relationViews[key], description: index === 2 ? 'Reintenta' : '' }));
      state = change(state, workspaceId, { action: 'set-steps', diagramId: view.diagramId, expectedRevision: find(state, 'entity', view.diagramId).value.revision, steps }).state; }
  }
  return { state, elements, placements, relationships, views };
}
const built = reference();

test('A3-012: C4 fixture reuses stable element/relationship IDs in all five native views and preserves semantic hierarchy', () => {
  const { state, elements: e, views } = built;
  assert.deepEqual(validateSnapshot(state, registry).filter((d) => d.severity === 'error'), []);
  assert.equal(c4Data(find(state, 'entity', e.api).value).parentId, e.boundary);
  assert.equal(c4Data(find(state, 'entity', e.boundary).value).parentId, e.system);
  assert.equal(c4Data(find(state, 'entity', e.planner).value).parentId, e.api);
  assert.equal(c4Data(find(state, 'entity', e.instance).value).instanceOfId, e.api);
  for (const key of ['context', 'containers', 'dynamic']) assert.equal(find(state, 'placement', views[key].placements.system, views[key].workspaceId).value.entityId, e.system);
  const order = c4View(find(state, 'entity', views.dynamic.diagramId).value).steps;
  assert.deepEqual(order.map((s) => s.order), [1, 2, 3]); assert.equal(order[0].relationViewId, order[2].relationViewId, 'a relationship can appear twice in a dynamic sequence');
  assert.equal(state.records.filter((r) => r.kind === 'group').length, 0);
  assert.deepEqual(state.records.filter((r) => r.kind === 'visual-edge'), fixture().records.filter((r) => r.kind === 'visual-edge'));
});

test('C4 hierarchy rejects cycles, wrong parent categories, missing instance targets and environment mismatches without changing the fixture', () => {
  const { state, elements: e } = built;
  for (const [key, patch, detail] of [
    ['system', { parentId: e.boundary }, 'c4-containment-cycle'], ['planner', { parentId: e.system }, 'c4-parent-category'], ['external', { parentId: e.boundary }, 'c4-parent-category'],
    ['instance', { instanceOfId: e.person }, 'c4-instance-target'], ['docker', { environment: 'staging' }, 'c4-environment-parent'],
    ['docker', { parentId: id(6000) }, 'c4-parent-missing']
  ]) { const entity = find(state, 'entity', e[key]).value; rejection(change(state, W1, { action: 'update-element', entityId: entity.id, expectedRevision: entity.revision, title: entity.title, tags: [], data: patch }, false).result, detail); }
});

test('C4 view scope and sequence references are validated per family; explicit dynamic ordering remains revision checked', () => {
  const { state, elements: e, views } = built;
  rejection(change(state, views.context.workspaceId, { action: 'show-element', entityId: e.planner, position: { x: 0, y: 0 } }, false).result, 'c4-view-element');
  rejection(change(state, id(++serial), { action: 'configure-view', title: 'wrong scope', kind: 'components', scopeEntityId: e.system, newWorkspace: true }, false).result, 'c4-view-scope');
  const diagram = find(state, 'entity', views.dynamic.diagramId).value, steps = c4View(diagram).steps;
  const op = { action: 'set-steps', diagramId: diagram.id, expectedRevision: diagram.revision, steps: steps.map((s, i) => ({ ...s, order: steps.length - i })) };
  const updated = change(state, views.dynamic.workspaceId, op).state;
  assert.equal(c4View(find(updated, 'entity', diagram.id).value).steps[0].id, steps.at(-1).id);
  rejection(change(updated, views.dynamic.workspaceId, op, false).result, 'revision-conflict');
  rejection(change(state, views.dynamic.workspaceId, { ...op, steps: [{ ...steps[0], relationViewId: id(6010) }] }, false).result, 'c4-step-relationship');
  assert.equal(change(state, views.dynamic.workspaceId, { ...op, steps: [steps[0], { ...steps[1], order: steps[0].order }] }, false).result.ok, false);
});

test('C4 custom types require an explicit category on their exact definition; unknown metadata survives edits', () => {
  const { state, elements: e } = built;
  const custom = find(state, 'entity', e.external).value;
  assert.equal(c4Category(custom, registry), 'software-system'); assert.equal(c4Category(custom, defaultRegistry()), undefined);
  assert.equal(c4Category({ type: 'demo.openai-service', typeVersion: '2.0.0' }, registry), undefined);
  assert.ok(validateDefinition('node-type', { ...scenario.customType, extensions: { 'a3.c4.category': 'guessed' } }).some((d) => d.detail === 'c4-category-invalid'));
  rejection(change(state, W1, { action: 'create-element', typeName: 'demo.person-without-mapping', typeVersion: '1.0.0', title: 'Person', data: {}, position: { x: 0, y: 0 } }, false).result, 'c4-type-mapping-missing');
  const copy = structuredClone(state), entity = find(copy, 'entity', e.system).value;
  entity.properties['a3.c4'].future = { opaque: [1, 2] }; entity.extensions['demo.future'] = { keep: true };
  const updated = change(copy, W1, { action: 'update-element', entityId: e.system, expectedRevision: entity.revision, title: 'A3 renamed', tags: ['Local'], data: { description: 'Nueva **descripción**' } }).state;
  assert.deepEqual(c4Data(find(updated, 'entity', e.system).value).future, { opaque: [1, 2] }); assert.deepEqual(find(updated, 'entity', e.system).value.extensions, entity.extensions);
});

test('A3-004/006 subset: moving/grouping a C4 representation never reparents or duplicates canonical elements', () => {
  const { state, elements: e, views } = built, ws = views.containers.workspaceId, placement = views.containers.placements.api;
  const parent = c4Data(find(state, 'entity', e.api).value).parentId;
  const moved = success(prepareCommand(state, request(state, 'a3.core.move-placement', { ref: { kind: 'placement', workspaceId: ws, id: placement }, position: { x: 1234, y: -10 } }), ctx)).nextSnapshot;
  assert.notDeepEqual(find(moved, 'placement', placement, ws).value.position, find(moved, 'placement', views.components.placements.api, views.components.workspaceId).value.position);
  assert.equal(c4Data(find(moved, 'entity', e.api).value).parentId, parent);
  const groupId = id(++serial), record = { kind: 'group', workspaceId: ws, value: { schemaVersion: '1.0.0', id: groupId, revision: 1, name: 'Visual only', members: [{ kind: 'placement', id: placement }], extensions: {} } };
  const grouped = success(prepareCommand(moved, request(moved, 'a3.core.create-document', { record }, [{ kind: 'group', workspaceId: ws, id: groupId }]), ctx)).nextSnapshot;
  assert.equal(c4Data(find(grouped, 'entity', e.api).value).parentId, parent); assert.equal(grouped.records.filter((r) => r.kind === 'entity').length, state.records.filter((r) => r.kind === 'entity').length);
});

test('A3-005 subset: duplicating C4 content remaps internal parents regardless of selection order and keeps external references', () => {
  const { state, elements: e, placements } = built, selected = ['api', 'boundary', 'system'];
  const entityIds = Object.fromEntries(selected.map((key) => [e[key], id(++serial)]));
  const placementIds = Object.fromEntries(selected.map((key) => [placements[key], id(++serial)]));
  const payload = { workspaceId: W1, placementIds: selected.map((key) => placements[key]), mode: 'content', offset: { x: 0, y: 500 }, includeExternalRelations: false,
    ids: { entities: entityIds, placements: placementIds, relations: {}, visualEdges: {}, relationViews: {} }, resourceCopies: [] };
  const absent = [...Object.values(entityIds).map((id) => ({ kind: 'entity', id })), ...Object.values(placementIds).map((id) => ({ kind: 'placement', id, workspaceId: W1 }))];
  const result = success(prepareCommand(state, request(state, 'a3.core.duplicate-selection', payload, absent), ctx));
  assert.equal(c4Data(find(result.nextSnapshot, 'entity', entityIds[e.api]).value).parentId, entityIds[e.boundary]);
  assert.equal(c4Data(find(result.nextSnapshot, 'entity', entityIds[e.boundary]).value).parentId, entityIds[e.system]);
  assert.equal(c4Data(find(result.nextSnapshot, 'entity', e.api).value).parentId, e.boundary);
});

test('C4 unknown view versions, source authority and malformed metadata preserve the fixture and produce localized diagnostics', () => {
  for (const mutate of [
    (entity) => { entity.properties['a3.c4.view'].version = '2.0.0'; },
    (entity) => { entity.properties['a3.c4.view'].steps = 'corrupt'; },
    (entity) => { entity.properties['a3.diagram.authority'] = 'source'; }
  ]) {
    const state = structuredClone(built.state), entity = find(state, 'entity', built.views.dynamic.diagramId).value;
    mutate(entity); const original = structuredClone(entity);
    assert.equal(c4View(entity), undefined);
    assert.ok(validateSnapshot(state, registry).some((d) => d.detail === 'c4-view-invalid' && d.ref?.id === entity.id));
    assert.deepEqual(entity, original);
    rejection(change(state, built.views.dynamic.workspaceId, { action: 'configure-view', title: entity.title, kind: 'dynamic', newWorkspace: false, expectedDiagramRevision: entity.revision }, false).result, 'c4-view-authority-required');
  }
});

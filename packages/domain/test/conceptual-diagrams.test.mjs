import assert from 'node:assert/strict';
import test from 'node:test';
import { CONCEPTUAL_NODE_CATALOG, CONCEPTUAL_RELATION_TYPE, conceptualNodeKind, conceptualRelationData, prepareCommand, validateSnapshot } from '../dist/src/index.js';
import { context, fixture, find, id, request, run, success, rejection, W1, W2, P1 } from './fixture.mjs';

function scopedRequest(state, command, payload, createdRefs = [], entityIds = []) {
  const source = request(state, command, payload, createdRefs);
  return { ...source, expectedContentHashes: [], scope: { entityIds: [...new Set([...state.records.filter((record) => record.kind === 'entity').map((record) => record.value.id), ...entityIds])] } };
}
function createNode(state, number, kind, title) {
  const payload = { workspaceId: W1, entityId: id(number), placementId: id(number + 100), kind, title, position: { x: number * 10, y: number * -3 } };
  const refs = [{ kind: 'entity', id: payload.entityId }, { kind: 'placement', id: payload.placementId, workspaceId: W1 }];
  return success(prepareCommand(state, scopedRequest(state, 'a3.conceptual.create-node', payload, refs, [payload.entityId]), context())).nextSnapshot;
}
function createRelation(state, number, sourcePlacementId, targetPlacementId, label, kind) {
  const payload = { workspaceId: W1, relationId: id(number), relationViewId: id(number + 100), sourcePlacementId, targetPlacementId, label, ...(kind ? { kind } : {}) };
  const refs = [{ kind: 'relation', id: payload.relationId }, { kind: 'relation-view', id: payload.relationViewId, workspaceId: W1 }];
  const result = prepareCommand(state, scopedRequest(state, 'a3.conceptual.create-relation', payload, refs), context());
  return { plan: success(result), payload };
}

test('E3-A1: typed conceptual node catalog creates all eight stable entity types', () => {
  assert.deepEqual(CONCEPTUAL_NODE_CATALOG.map((entry) => entry.kind), ['concept', 'idea', 'note', 'decision', 'question', 'cause', 'result', 'reference']);
  let state = fixture();
  for (const [index, entry] of CONCEPTUAL_NODE_CATALOG.entries()) state = createNode(state, 700 + index * 2, entry.kind, `Nodo ${entry.kind}`);
  const nodes = state.records.filter((record) => record.kind === 'entity' && conceptualNodeKind(record.value.type));
  assert.equal(nodes.length, 8);
  assert.deepEqual(nodes.map((record) => conceptualNodeKind(record.value.type)), CONCEPTUAL_NODE_CATALOG.map((entry) => entry.kind));
  assert.equal(conceptualNodeKind('a3.conceptual.concept', '2.0.0'), undefined, 'an unsupported node type version is not treated as the built-in');
  assert.equal(validateSnapshot(state, context().registry).filter((diagnostic) => diagnostic.severity === 'error').length, 0);
});

test('E3-A1: conceptual cycles and self links are valid semantic relations with separate view records', () => {
  let state = fixture();
  state = createNode(state, 710, 'concept', 'A'); state = createNode(state, 712, 'idea', 'B'); state = createNode(state, 714, 'question', 'C');
  const placements = state.records.filter((record) => record.kind === 'placement' && [id(710), id(712), id(714)].includes(record.value.entityId));
  let edge = createRelation(state, 720, id(810), id(812), 'inspira', 'cause'); state = edge.plan.nextSnapshot;
  edge = createRelation(state, 722, id(812), id(814), 'abre', 'dependency'); state = edge.plan.nextSnapshot;
  edge = createRelation(state, 724, id(814), id(810), 'regresa', 'association'); state = edge.plan.nextSnapshot;
  edge = createRelation(state, 726, id(810), id(810), 'se examina', undefined); state = edge.plan.nextSnapshot;
  const diagnostics = validateSnapshot(state, context().registry);
  assert.equal(diagnostics.filter((item) => item.severity === 'error').length, 0, JSON.stringify(diagnostics));
  assert.equal(state.records.filter((record) => record.kind === 'relation' && record.value.type === CONCEPTUAL_RELATION_TYPE).length, 4);
  assert.equal(state.records.filter((record) => record.kind === 'relation-view').length,
    fixture().records.filter((record) => record.kind === 'relation-view').length + 4);
  assert.ok(state.records.filter((record) => record.kind === 'relation' && record.value.type === CONCEPTUAL_RELATION_TYPE)
    .every((record) => conceptualRelationData(record.value.properties)?.label));
  assert.equal(state.records.filter((record) => record.kind === 'visual-edge').length, fixture().records.filter((record) => record.kind === 'visual-edge').length);
  assert.equal(placements.length, 3);
});

test('E3-A1: inspector commands edit title, kind, label and optional relationship type without losing unknown fields', () => {
  let state = fixture(); state = createNode(state, 730, 'concept', 'Original'); state = createNode(state, 732, 'note', 'Destino');
  state = structuredClone(state); const first = find(state, 'entity', id(730)); first.value.properties['future.opaque'] = { keep: ['all'] };
  const created = createRelation(state, 740, id(830), id(832), 'apunta a', 'dependency'); state = created.plan.nextSnapshot;
  const entityPatch = { workspaceId: W1, entityId: id(730), kind: 'decision', title: 'Decisión' };
  const entityResult = success(prepareCommand(state, scopedRequest(state, 'a3.conceptual.update-node', entityPatch, [], [id(730)]), context()));
  assert.equal(find(entityResult.nextSnapshot, 'entity', id(730)).value.type, 'a3.conceptual.decision');
  assert.equal(find(entityResult.nextSnapshot, 'entity', id(730)).value.title, 'Decisión');
  assert.deepEqual(find(entityResult.nextSnapshot, 'entity', id(730)).value.properties['future.opaque'], { keep: ['all'] });
  const relationPatch = { workspaceId: W1, relationId: id(740), label: 'justifica', kind: null };
  const relationResult = success(prepareCommand(entityResult.nextSnapshot, scopedRequest(entityResult.nextSnapshot, 'a3.conceptual.update-relation', relationPatch), context()));
  const relation = find(relationResult.nextSnapshot, 'relation', id(740));
  assert.equal(conceptualRelationData(relation.value.properties).label, 'justifica');
  assert.equal('a3.conceptual.kind' in relation.value.properties, false);
  assert.equal(find(relationResult.nextSnapshot, 'relation-view', id(840), W1).value.id, id(840));
  const stale = scopedRequest(relationResult.nextSnapshot, 'a3.conceptual.update-relation', relationPatch);
  stale.expectedRevisions = stale.expectedRevisions.map((expected) => expected.kind === 'relation' && expected.id === id(740) ? { ...expected, revision: 1 } : expected);
  rejection(prepareCommand(relationResult.nextSnapshot, stale, context()), 'revision-conflict');
});

test('E3-A1: relation endpoints must be concept nodes and deleting one removes only semantic relation views', () => {
  let state = fixture(); state = createNode(state, 750, 'concept', 'Permitido');
  const invalid = { workspaceId: W1, relationId: id(752), relationViewId: id(753), sourcePlacementId: id(850), targetPlacementId: P1, label: 'separa' };
  rejection(prepareCommand(state, scopedRequest(state, 'a3.conceptual.create-relation', invalid,
    [{ kind: 'relation', id: id(752) }, { kind: 'relation-view', id: id(753), workspaceId: W1 }]), context()), 'conceptual-endpoint-required');
  state = createNode(state, 754, 'result', 'Resultado');
  let created = createRelation(state, 756, id(850), id(854), 'explica', 'composition'); state = created.plan.nextSnapshot;
  rejection(run(state, 'a3.conceptual.delete-relation', { workspaceId: W2, relationId: id(756) }, [], context()), 'conceptual-relation-missing');
  const visualCount = state.records.filter((record) => record.kind === 'visual-edge').length;
  const deletion = success(run(state, 'a3.conceptual.delete-relation', { workspaceId: W1, relationId: id(756) }, [], context()));
  assert.equal(find(deletion.nextSnapshot, 'relation', id(756)), undefined);
  assert.equal(find(deletion.nextSnapshot, 'relation-view', id(856), W1), undefined);
  assert.equal(deletion.nextSnapshot.records.filter((record) => record.kind === 'visual-edge').length, visualCount);
  assert.ok(find(deletion.nextSnapshot, 'entity', id(750)) && find(deletion.nextSnapshot, 'entity', id(754)));
});

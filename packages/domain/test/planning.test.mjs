import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { planningData, planningHistory, planningKind, validateSnapshot, defaultRegistry, prepareCommand, TASK_STATES } from '../dist/src/index.js';
import { fixture, request, context, id, find, success, rejection, R1 } from './fixture.mjs';

const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const initial = () => ({ records: [...fixture().records, ...structuredClone(records)] });
const get = (state, entityId) => find(state, 'entity', entityId).value;
let sequence = 4500;
function change(state, operations, actor = { kind: 'user', id: 'planner' }, extra = {}) {
  const created = operations.filter((op) => op.action === 'create').map((op) => ({ kind: 'entity', id: op.entityId }));
  const payload = { occurredAt: '2026-10-16T13:00:00.000Z', operations };
  const envelope = request(state, 'a3.planning.change', payload, created, { operationId: id(sequence++), actor,
    scope: { entityIds: [...state.records.filter((r) => r.kind === 'entity').map((r) => r.value.id), ...created.map((r) => r.id)] }, ...extra });
  return prepareCommand(state, envelope, context({ authenticatedActor: actor }));
}
const update = (state, entityId, patch = {}) => ({ action: 'update', entityId, expectedRevision: get(state, entityId).revision,
  title: get(state, entityId).title, data: { ...structuredClone(planningData(get(state, entityId))), ...patch } });

test('A3-020: persistent planning fixture has stories, own criterion IDs, five evidence kinds and canonical Markdown references', () => {
  const state = initial();
  assert.deepEqual(validateSnapshot(state, defaultRegistry()).filter((d) => d.severity === 'error'), []);
  const story = planningData(get(state, scenario.storyId)), task = planningData(get(state, scenario.taskId));
  assert.equal(story.actor, 'Diseñadora de proyectos'); assert.ok(story.need && story.goal);
  assert.deepEqual(story.criterionIds, [scenario.criterionId]); assert.equal(planningData(get(state, scenario.criterionId)).storyId, scenario.storyId);
  assert.equal(get(state, scenario.storyId).contentResourceId, R1); assert.equal(task.state, 'todo');
  assert.deepEqual(scenario.evidenceIds.map((evidenceId) => planningData(get(state, evidenceId)).target.kind), ['file', 'result', 'note', 'capture', 'commit']);
  assert.equal(state.records.filter((r) => r.kind === 'visual-edge').length, fixture().records.filter((r) => r.kind === 'visual-edge').length);
});

test('story and criterion creation validate together in a logical batch; rename preserves IDs and unknown metadata', () => {
  const state = initial(), storyId = id(4601), criterionId = id(4602);
  const result = success(change(state, [
    { action: 'create', entityId: storyId, title: 'New story', data: { ...planningData(get(state, scenario.storyId)), criterionIds: [criterionId] } },
    { action: 'create', entityId: criterionId, title: 'New criterion', data: { kind: 'criterion', storyId, references: [] } }
  ]));
  const renamed = update(result.nextSnapshot, storyId); renamed.title = 'Renamed story';
  const after = success(change(result.nextSnapshot, [renamed])).nextSnapshot;
  assert.equal(get(after, storyId).id, storyId); assert.deepEqual(planningData(get(after, storyId)).criterionIds, [criterionId]);
  assert.deepEqual(planningData(get(after, storyId)).futureStory, { keep: true });
  assert.equal(planningHistory(get(after, storyId)).length, 2);
});

test('all task states record user/agent/extension identity and state history on the same entity', () => {
  let state = initial();
  for (const [index, status] of TASK_STATES.entries()) {
    const actor = { kind: ['user', 'agent', 'extension'][index % 3], id: 'authenticated-' + index };
    state = success(change(state, [update(state, scenario.taskId, { state: status, evidenceIds: scenario.evidenceIds })], actor)).nextSnapshot;
    assert.equal(planningData(get(state, scenario.taskId)).state, status);
    assert.deepEqual(planningHistory(get(state, scenario.taskId)).at(-1).actor, actor);
    assert.equal(planningHistory(get(state, scenario.taskId)).at(-1).toState, status);
  }
  assert.equal(get(state, scenario.taskId).revision, TASK_STATES.length + 1);
});

test('Markdown descriptions attach/detach by resource ID without copying bytes; assignee metadata survives edits', () => {
  let state = initial();
  const assigned = update(state, scenario.dependentId, { assignee: { kind: 'user', id: 'owner', futureMetadata: 'keep' } }); assigned.contentResourceId = R1;
  state = success(change(state, [assigned])).nextSnapshot;
  assert.equal(get(state, scenario.dependentId).contentResourceId, R1);
  const revised = update(state, scenario.dependentId, { assignee: { kind: 'user', id: 'owner' } }); revised.contentResourceId = null;
  const plan = success(change(state, [revised]));
  assert.equal(get(plan.nextSnapshot, scenario.dependentId).contentResourceId, undefined);
  assert.equal(planningData(get(plan.nextSnapshot, scenario.dependentId)).assignee.futureMetadata, 'keep');
  assert.deepEqual(plan.contentEffects, []);
  const invalid = update(state, scenario.dependentId); invalid.contentResourceId = id(99995);
  rejection(change(state, [invalid]));
});

test('dependencies reject direct/indirect cycles, wrong family and absent IDs; visual lines do not add dependencies', () => {
  const state = initial();
  rejection(change(state, [update(state, scenario.taskId, { dependencyIds: [scenario.dependentId] })]), 'planning-dependency-cycle');
  rejection(change(state, [update(state, scenario.taskId, { dependencyIds: [scenario.taskId] })]), 'planning-dependency-invalid');
  rejection(change(state, [update(state, scenario.taskId, { dependencyIds: [scenario.storyId] })]), 'planning-dependency-invalid');
  rejection(change(state, [update(state, scenario.taskId, { dependencyIds: [id(99999)] })]), 'planning-dependency-invalid');
  rejection(change(state, [update(state, scenario.storyId, { dependencyIds: [scenario.storyId] })]), 'planning-dependency-cycle');
  assert.equal(planningData(get(state, scenario.taskId)).dependencyIds.length, 0);
});

test('missing criteria/evidence/references and inconsistent story membership fail without mutating source', () => {
  const state = initial(), before = structuredClone(state);
  rejection(change(state, [update(state, scenario.storyId, { criterionIds: [] })]), 'planning-story-criterion-mismatch');
  rejection(change(state, [update(state, scenario.taskId, { criterionIds: [id(99991)] })]), 'planning-criterion-invalid');
  rejection(change(state, [update(state, scenario.taskId, { evidenceIds: [id(99992)] })]), 'planning-evidence-missing');
  rejection(change(state, [update(state, scenario.taskId, { evidenceIds: scenario.evidenceIds, criterionIds: [] })]), 'planning-evidence-criterion-mismatch');
  rejection(change(state, [update(state, scenario.taskId, { references: [{ kind: 'resource', id: id(99993) }] })]), 'planning-reference-missing');
  assert.deepEqual(state, before);
});

test('shared prerequisites form a valid DAG; only the explicit dependency graph is checked for cycles', () => {
  const state = initial(), taskIds = [id(4800), id(4801), id(4802), id(4803)];
  const operations = taskIds.map((entityId, index) => ({ action: 'create', entityId, title: 'DAG task ' + index,
    data: { ...planningData(get(state, scenario.taskId)), dependencyIds: index === 0 ? [] : index === 3 ? [taskIds[1], taskIds[2]] : [taskIds[0]] } }));
  const after = success(change(state, operations)).nextSnapshot;
  assert.deepEqual(validateSnapshot(after, defaultRegistry()).filter((d) => d.severity === 'error'), []);
  rejection(change(after, [update(after, taskIds[0], { dependencyIds: [taskIds[3]] })]), 'planning-dependency-cycle');
});

test('evidence creation stamps the authenticated actor; original target and attribution are immutable', () => {
  const state = initial(), entityId = id(4700), actor = { kind: 'agent', id: 'agent-1' };
  const op = { action: 'create', entityId, title: 'Test result', data: { kind: 'evidence', target: { kind: 'result', entityId: scenario.taskId }, criterionIds: [scenario.criterionId] } };
  const plan = success(change(state, [op], actor)), evidence = get(plan.nextSnapshot, entityId), data = planningData(evidence);
  assert.deepEqual(data.recordedBy, actor); assert.equal(data.recordedAt, '2026-10-16T13:00:00.000Z');
  rejection(change(state, [{ ...op, data: { ...op.data, recordedBy: { kind: 'user', id: 'spoofed' } } }]), 'planning-command-invalid');
  const { recordedBy, recordedAt, ...input } = data;
  const next = { action: 'update', entityId, expectedRevision: evidence.revision, title: 'Revised caption', data: input };
  const after = success(change(plan.nextSnapshot, [next], { kind: 'extension', id: 'reviewer' })).nextSnapshot;
  assert.deepEqual(planningData(get(after, entityId)).recordedBy, actor);
  rejection(change(after, [{ ...next, expectedRevision: 2, data: { ...input, target: { kind: 'file', resourceId: R1 } } }]), 'planning-evidence-target-immutable');
  rejection(change(state, [{ ...op, data: { ...op.data, target: { kind: 'commit', repositoryResourceId: R1, hash: 'main' } } }]), 'planning-command-invalid');
  rejection(change(state, [{ ...op, data: { ...op.data, target: { kind: 'file', resourceId: id(99994) } } }]), 'planning-evidence-target-missing');
});

test('revision, identity, duplicate operation and generic write bypasses fail safely', () => {
  const state = initial(), op = update(state, scenario.taskId, { state: 'in_progress' });
  rejection(change(state, [{ ...op, expectedRevision: 99 }]), 'planning-revision-conflict');
  rejection(change(state, [op, op]), 'planning-command-invalid');
  const historyId = planningHistory(get(state, scenario.taskId))[0].operationId;
  rejection(change(state, [op], undefined, { operationId: historyId }), 'planning-operation-repeated');
  rejection(change(state, [op], { kind: 'importer', id: 'not-an-approved-actor' }), 'planning-actor-invalid');
  const bypass = request(state, 'a3.core.update-entity', { title: 'Untracked title' }, [], { scope: { entityIds: [scenario.taskId] } });
  rejection(prepareCommand(state, bypass, context()), 'planning-command-required');
  rejection(change(state, [{ ...op, data: { ...op.data, state: 'completed' } }]), 'planning-command-invalid');
});

test('future planning versions remain opaque and a corrupt known history is diagnosed without replacing data', () => {
  const future = get(initial(), scenario.taskId); future.typeVersion = '2.0.0'; future.properties['a3.planning'] = { opaque: 'preserve' };
  assert.equal(planningKind(future), undefined); assert.equal(planningData(future), undefined);
  const state = initial(); get(state, scenario.taskId).properties['a3.planning.history'][0].actor.kind = 'forged';
  assert.ok(validateSnapshot(state, defaultRegistry()).some((d) => d.detail === 'planning-data-invalid'));
});

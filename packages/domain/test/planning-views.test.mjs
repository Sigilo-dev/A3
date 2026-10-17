import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { projectPlanning, groupPlanningTasks, inspectTaskProposal, planningData, PLANNING_POLICY_KEY } from '../dist/src/index.js';
import { fixture, run, context, id, find, success, rejection, W1, W2 } from './fixture.mjs';
const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const proposal = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/task-proposal.json', import.meta.url), 'utf8'));
const initial = () => ({ records: [...fixture().records, ...structuredClone(records)] });
const get = (state, entityId) => find(state, 'entity', entityId).value;
function change(state, evidenceIds = [], status = 'done') {
  const task = get(state, scenario.taskId), operation = { action: 'update', entityId: task.id, expectedRevision: task.revision, title: task.title, data: { ...planningData(task), state: status, evidenceIds } };
  return run(state, 'a3.planning.change', { occurredAt: '2026-10-16T14:00:00.000Z', operations: [operation] }, [], context(), { operationId: id(6300) });
}
test('A3-020: checklist projection deduplicates canonical tasks and groups their representations by story/workspace', () => {
  const state = initial();
  for (const [index, workspaceId] of [W1, W2].entries()) state.records.push({ kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id: id(6100 + index), revision: 1, entityId: scenario.taskId, position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, style: {}, extensions: {} } });
  const projection = projectPlanning(state);
  assert.equal(projection.items.filter((item) => item.id === scenario.taskId).length, 1);
  assert.equal(groupPlanningTasks(projection, { groupBy: 'workspace' }).filter((g) => g.tasks.some((t) => t.id === scenario.taskId)).length, 2);
  assert.equal(groupPlanningTasks(projection, { groupBy: 'story' }).length, 1);
  assert.equal(groupPlanningTasks(projection, { search: 'reapertura', state: 'todo', priority: 'high', workspaceId: W2 })[0].tasks[0].id, scenario.taskId);
  assert.equal(groupPlanningTasks(projection, { search: 'no-match' })[0].tasks.length, 0);
  assert.deepEqual(projection.criteriaWithoutEvidence.map((c) => c.id), [scenario.criterionId], 'loose evidence not linked to a task is not coverage');
  const after = projectPlanning(success(change(state, [scenario.evidenceIds[0]])).nextSnapshot);
  assert.equal(after.criteriaWithoutEvidence.length, 0);
});
test('known evidence policy gates done, records evidence/actor, and cannot be relaxed by agents', () => {
  const base = initial(), state = success(run(base, 'a3.planning.set-policy', { requireEvidenceForDone: true })).nextSnapshot;
  rejection(change(state), 'planning-evidence-required');
  const plan = success(change(state, [scenario.evidenceIds[0]]));
  const event = get(plan.nextSnapshot, scenario.taskId).properties['a3.planning.history'].at(-1);
  assert.deepEqual(event.evidenceIds, [scenario.evidenceIds[0]]); assert.equal(event.actor.kind, 'user');
  const agent = { kind: 'agent', id: 'agent' };
  rejection(run(state, 'a3.planning.set-policy', { requireEvidenceForDone: false }, [], context({ authenticatedActor: agent }), { actor: agent }), 'planning-policy-human-required');
  const corrupt = structuredClone(state); corrupt.records.find((r) => r.kind === 'project').value.extensions[PLANNING_POLICY_KEY] = { requireEvidenceForDone: 'false' };
  rejection(change(corrupt, [scenario.evidenceIds[0]]), 'planning-policy-invalid');
});
test('policy cannot be overwritten through generic canvas history', () => {
  const state = initial(), project = state.records.find((r) => r.kind === 'project'), after = structuredClone(project);
  after.value.extensions[PLANNING_POLICY_KEY] = { requireEvidenceForDone: false };
  const payload = { workspaceId: W1, direction: 'redo', changes: [{ ref: { kind: 'project', id: project.value.projectId }, before: project, after }], contentEffects: [], revisionFloors: {} };
  const result = run(state, 'a3.core.apply-canvas-history', payload);
  rejection(result, 'planning-policy-command-required');
});
test('A3-021 subset: referenced draft validation never creates tasks and rejects foreign projects, cycles, missing sources and invented completed states', () => {
  const state = initial(), original = structuredClone(state);
  assert.deepEqual(inspectTaskProposal(state, JSON.stringify(proposal)).issues, []);
  const variants = [
    { ...proposal, projectId: id(99999) },
    { ...proposal, sourceRefs: [] },
    { ...proposal, items: proposal.items.map((item, index) => index ? item : { ...item, dependencyKeys: ['documentar-apertura'] }) },
    { ...proposal, items: [{ ...proposal.items[0], state: 'done' }] },
    { ...proposal, items: [{ ...proposal.items[0], requirementIds: [id(99998)] }] }
  ];
  for (const variant of variants) assert.ok(inspectTaskProposal(state, JSON.stringify(variant)).issues.length > 0);
  assert.equal(inspectTaskProposal(state, '{bad json').proposal, null);
  assert.deepEqual(state, original);
});

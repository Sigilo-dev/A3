import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, W1 } from './fixture.mjs';
const W2 = '00000000-0000-4000-8000-000000000007';
const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const proposal = await readFile(new URL('../../../fixtures/e4/planning/task-proposal.json', import.meta.url), 'utf8');
const windows = { skip: process.platform !== 'win32' };
async function setup(t) {
  const { root, tempRoot } = await scratch(t); await mkdir(join(root, 'assets'), { recursive: true });
  await cp(new URL('../../../fixtures/e4/planning/planning-capture.svg', import.meta.url), join(root, 'assets/planning-capture.svg'));
  for (const record of records) await writeFile(join(root, '.a3', record.kind === 'entity' ? 'entities' : 'resources', record.value.id + '.json'), JSON.stringify(record.value, null, 2) + '\n');
  const host = await fixtureHost(root, 'checklist-person'), manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const sessionId = (await manager.openFolder(root)).active.sessionId; return { root, manager, sessionId, host };
}
const task = (state, id = scenario.taskId) => state.items.find((item) => item.id === id);
test('A3-020: a checklist and task nodes in two workspaces share state, actor/evidence and revision conflicts after reopen', windows, async (t) => {
  const c = await setup(t), { manager, sessionId } = c, source = join(c.root, 'pages/readme.md'), original = await readFile(source);
  let state = await manager.loadPlanning(sessionId);
  const first = await manager.showPlanningTask(sessionId, scenario.taskId, W1), second = await manager.showPlanningTask(sessionId, scenario.taskId, W2);
  assert.notEqual(first.placementId, second.placementId); assert.deepEqual(await manager.showPlanningTask(sessionId, scenario.taskId, W1), first);
  state = await manager.setPlanningPolicy(sessionId, state.projectRevision, true);
  const stale = { entityId: scenario.taskId, expectedRevision: task(state).revision, state: 'done', evidenceIds: [] };
  await assert.rejects(manager.updatePlanningTask(sessionId, stale), /planning-evidence-required/);
  state = await manager.addPlanningEvidence(sessionId, { taskId: scenario.taskId, expectedRevision: task(state).revision, title: 'Reapertura revisada', target: { kind: 'file', resourceId: '00000000-0000-4000-8000-000000000004' }, criterionIds: [scenario.criterionId] });
  const evidenceIds = task(state).data.evidenceIds;
  state = await manager.updatePlanningTask(sessionId, { ...stale, expectedRevision: task(state).revision, evidenceIds });
  assert.equal(task(state).data.state, 'done'); assert.equal(state.criteriaWithoutEvidence.length, 0);
  for (const workspaceId of [W1, W2]) { const canvas = await manager.loadCanvasWorkspace(sessionId, workspaceId), node = canvas.entities.find((e) => e.id === scenario.taskId);
    assert.equal(node.properties['a3.planning'].state, 'done'); assert.equal(node.typeAvailable, true); assert.equal(node.revision, task(state).revision); }
  assert.deepEqual(task(state).history.at(-1).actor, c.host.authenticatedActor); assert.deepEqual(task(state).history.at(-1).evidenceIds, evidenceIds);
  // Simulate a node changing the canonical task while an old checklist row still holds its revision.
  const rowRevision = task(state).revision;
  state = await manager.updatePlanningTask(sessionId, { entityId: scenario.taskId, expectedRevision: rowRevision, state: 'in_progress', evidenceIds });
  await assert.rejects(manager.updatePlanningTask(sessionId, { entityId: scenario.taskId, expectedRevision: rowRevision, state: 'cancelled', evidenceIds }), { code: 'REVISION_CONFLICT' });
  assert.equal(task(await manager.loadPlanning(sessionId)).data.state, 'in_progress');
  await manager.closeActive(sessionId); const reopened = (await manager.openFolder(c.root)).active.sessionId;
  assert.equal(task(await manager.loadPlanning(reopened)).data.state, 'in_progress'); assert.deepEqual(await readFile(source), original);
});
test('referenced drafts require preview and explicit acceptance; excluded dependencies, stale previews and replay preserve canonical tasks', windows, async (t) => {
  const { manager, sessionId } = await setup(t), before = await manager.loadPlanning(sessionId), count = before.items.length;
  let preview = await manager.previewPlanningProposal(sessionId, proposal);
  assert.equal(preview.coverageClaim, false); assert.deepEqual(preview.issues, []); assert.ok(preview.token);
  assert.equal((await manager.loadPlanning(sessionId)).items.length, count);
  await assert.rejects(manager.applyPlanningProposal(sessionId, preview.token, ['documentar-apertura']), { code: 'PLANNING_DEPENDENCY_EXCLUDED' });
  assert.equal((await manager.loadPlanning(sessionId)).items.length, count);
  await manager.createPlanningTask(sessionId, 'Cambio posterior a preview');
  await assert.rejects(manager.applyPlanningProposal(sessionId, preview.token, ['revisar-apertura']), { code: 'REVISION_CONFLICT' });
  preview = await manager.previewPlanningProposal(sessionId, proposal);
  const applied = await manager.applyPlanningProposal(sessionId, preview.token, ['revisar-apertura', 'documentar-apertura']);
  const proposed = applied.items.filter((item) => item.data.proposal); assert.equal(proposed.length, 2);
  assert.ok(proposed.every((item) => item.data.state === 'todo' && item.data.evidenceIds.length === 0 && item.data.proposal.coverageClaim === false));
  assert.equal(proposed.find((item) => item.data.proposal.key === 'documentar-apertura').data.dependencyIds[0], proposed.find((item) => item.data.proposal.key === 'revisar-apertura').id);
  await assert.rejects(manager.applyPlanningProposal(sessionId, preview.token, ['revisar-apertura']), { code: 'PLANNING_PROPOSAL_MISSING' });
  const foreign = JSON.parse(proposal); foreign.projectId = '00000000-0000-4000-8000-000000000099';
  assert.equal((await manager.previewPlanningProposal(sessionId, JSON.stringify(foreign))).token, null);
});
test('pending requirements and criteria derive from the project model; revocation denies checklist updates and policy changes', windows, async (t) => {
  const { root, manager, sessionId, host } = await setup(t);
  let state = await manager.createPlanningStory(sessionId, { title: 'Nueva necesidad', actor: 'Persona', need: 'Continuar proyecto', goal: 'Conservar contexto', criteria: ['Conservar IDs'] });
  const story = state.requirementsWithoutTask.find((item) => item.title === 'Nueva necesidad'); assert.ok(story);
  state = await manager.createPlanningTask(sessionId, 'Revisar IDs', story.id);
  assert.equal(state.requirementsWithoutTask.some((item) => item.id === story.id), false);
  assert.ok(state.criteriaWithoutEvidence.some((item) => item.title === 'Conservar IDs'));
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'task.edit', mode: 'deny' });
  assert.equal((await manager.loadPlanning(sessionId)).canEdit, false);
  await assert.rejects(manager.updatePlanningTask(sessionId, { entityId: scenario.taskId, expectedRevision: task(state).revision, state: 'done', evidenceIds: scenario.evidenceIds }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(manager.setPlanningPolicy(sessionId, state.projectRevision, true), { code: 'PERMISSION_DENIED' });
});

test('proposal tokens cannot cross a closed session or reopen, including the same project path', windows, async (t) => {
  const { root, manager, sessionId } = await setup(t);
  const preview = await manager.previewPlanningProposal(sessionId, proposal); assert.ok(preview.token);
  await manager.closeActive(sessionId); const next = (await manager.openFolder(root)).active.sessionId;
  await assert.rejects(manager.applyPlanningProposal(sessionId, preview.token, ['revisar-apertura']), { code: 'STALE_SESSION' });
  await assert.rejects(manager.applyPlanningProposal(next, preview.token, ['revisar-apertura']), { code: 'PLANNING_PROPOSAL_MISSING' });
});

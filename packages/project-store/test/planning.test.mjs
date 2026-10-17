import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { planningData, planningHistory, revisionsOf } from '@a3/domain';
import { openProjectService } from '../dist/index.js';
import { readProject } from '../dist/reader.js';
import { fixtureHost, id, scratch } from './fixture.mjs';

const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const windows = { skip: process.platform !== 'win32' };
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result.value; };
let sequence = 4900;
const entity = (service, entityId) => service.state.project.snapshot.records.find((record) => record.kind === 'entity' && record.value.id === entityId).value;
const createOps = () => records.filter((record) => record.kind === 'entity').map(({ value }) => {
  const data = structuredClone(value.properties['a3.planning']); delete data.recordedBy; delete data.recordedAt;
  return { action: 'create', entityId: value.id, title: value.title, data, ...(value.contentResourceId ? { contentResourceId: value.contentResourceId } : {}) };
});
async function setup(t) {
  const { root, tempRoot } = await scratch(t);
  const resource = records.find((record) => record.kind === 'resource');
  await mkdir(join(root, 'assets'), { recursive: true });
  await cp(new URL('../../../fixtures/e4/planning/planning-capture.svg', import.meta.url), join(root, resource.value.path));
  await writeFile(join(root, '.a3/resources', resource.value.id + '.json'), JSON.stringify(resource.value, null, 2) + '\n');
  const host = await fixtureHost(root, 'planning-user'); const leases = [];
  t.after(async () => { for (const lease of leases) await lease.close(); });
  const open = async () => { const lease = ok(await openProjectService(root, { host, pollMs: 5000 })); leases.push(lease); return lease; };
  return { root, tempRoot, host, open, lease: await open() };
}
function command(service, host, operations) {
  const snapshot = service.state.project.snapshot;
  return { operationId: id(sequence++), projectId: host.projectId, actor: host.authenticatedActor, command: 'a3.planning.change',
    payload: { occurredAt: new Date().toISOString(), operations }, expectedRevisions: [...revisionsOf(snapshot), ...operations.filter((op) => op.action === 'create').map((op) => ({ kind: 'entity', id: op.entityId, revision: null }))],
    expectedContentHashes: [], scope: { entityIds: [...new Set([...snapshot.records.filter((record) => record.kind === 'entity').map((record) => record.value.id), ...operations.map((op) => op.entityId)])] } };
}
function update(service, entityId, patch) {
  const value = entity(service, entityId);
  return { action: 'update', entityId, expectedRevision: value.revision, title: value.title, data: { ...structuredClone(planningData(value)), ...patch } };
}

test('A3-020: transactional planning batch reopens with stable story/criteria/task IDs, evidence and authenticated activity', windows, async (t) => {
  const c = await setup(t), service = c.lease.service, sourcePath = join(c.root, 'pages/readme.md'), before = await readFile(sourcePath);
  const created = command(service, c.host, createOps()); const receipt = ok(await service.commit(ok(await service.prepare(created))));
  assert.equal(receipt.atomic, false); assert.equal(receipt.status, 'committed');
  const value = entity(service, scenario.taskId), story = entity(service, scenario.storyId);
  assert.equal(value.revision, 1); assert.equal(story.contentResourceId, '00000000-0000-4000-8000-000000000004');
  const fileEvidence = entity(service, scenario.evidenceIds[0]);
  assert.deepEqual(planningData(fileEvidence).recordedBy, c.host.authenticatedActor);
  const edit = command(service, c.host, [update(service, scenario.taskId, { state: 'done', evidenceIds: scenario.evidenceIds })]);
  ok(await service.commit(ok(await service.prepare(edit))));
  await c.lease.close(); const reopened = (await c.open()).service;
  const task = entity(reopened, scenario.taskId), data = planningData(task);
  assert.equal(data.state, 'done'); assert.equal(task.revision, 2); assert.deepEqual(data.criterionIds, [scenario.criterionId]);
  assert.deepEqual(data.evidenceIds, scenario.evidenceIds); assert.equal(planningData(entity(reopened, scenario.criterionId)).storyId, scenario.storyId);
  assert.equal(planningHistory(task).length, 2); assert.equal(planningHistory(task).at(-1).fromState, 'todo');
  assert.deepEqual(planningHistory(task).at(-1).actor, c.host.authenticatedActor);
  assert.deepEqual(planningData(entity(reopened, scenario.storyId)).futureStory, { keep: true });
  assert.deepEqual(await readFile(sourcePath), before);
  const path = join(c.root, '.a3/entities', scenario.taskId + '.json');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).properties['a3.planning'].state, 'done');
  const stale = await reopened.prepare(edit); assert.equal(stale.ok, false); assert.ok(stale.diagnostics.some((d) => d.code === 'REVISION_CONFLICT'));
  const cycle = await reopened.prepare(command(reopened, c.host, [update(reopened, scenario.taskId, { dependencyIds: [scenario.dependentId] })]));
  assert.equal(cycle.ok, false); assert.ok(cycle.diagnostics.some((d) => d.detail === 'planning-dependency-cycle'));
});

test('planning requires task.edit even with document.edit; revocation before apply preserves every original byte', windows, async (t) => {
  const c = await setup(t), service = c.lease.service;
  assert.equal(await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'task.edit', mode: 'deny' }), true);
  const input = command(service, c.host, createOps()), denied = await service.prepare(input);
  assert.equal(denied.ok, false); assert.ok(denied.diagnostics.some((d) => d.missingCapability === 'task.edit' || d.message.includes('task.edit')));
  assert.equal(service.state.project.snapshot.records.some((r) => r.kind === 'entity' && r.value.id === scenario.storyId), false);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'task.edit', mode: 'direct' });
  const prepared = ok(await service.prepare(input));
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'task.edit', mode: 'deny' });
  const revoked = await service.commit(prepared); assert.equal(revoked.ok, false); assert.ok(revoked.diagnostics.some((d) => d.code === 'PERMISSION_DENIED'));
  assert.equal(service.state.project.snapshot.records.some((r) => r.kind === 'entity' && r.value.id === scenario.storyId), false);
  await assert.rejects(readFile(join(c.root, '.a3/entities', scenario.storyId + '.json')), { code: 'ENOENT' });
});

test('known planning corruption and future type versions retain source bytes and other valid documents', windows, async (t) => {
  const c = await setup(t), service = c.lease.service;
  ok(await service.commit(ok(await service.prepare(command(service, c.host, createOps())))));
  await c.lease.close();
  const path = join(c.root, '.a3/entities', scenario.taskId + '.json'), data = JSON.parse(await readFile(path, 'utf8'));
  data.properties['a3.planning'].dependencyIds = [id(99999)];
  const corrupt = Buffer.from(JSON.stringify(data, null, 2) + '\n'); await writeFile(path, corrupt);
  const degraded = await readProject(c.root);
  assert.ok(degraded.diagnostics.some((d) => d.detail === 'planning-dependency-invalid'));
  assert.ok(degraded.snapshot.records.some((r) => r.kind === 'entity' && r.value.id === scenario.storyId));
  assert.deepEqual(await readFile(path), corrupt);
  data.typeVersion = '2.0.0'; data.properties['a3.planning'] = { futureModel: ['preserved'] };
  const future = Buffer.from(JSON.stringify(data, null, 2) + '\n'); await writeFile(path, future);
  const read = await readProject(c.root), opaque = read.snapshot.records.find((r) => r.kind === 'entity' && r.value.id === scenario.taskId);
  assert.equal(planningData(opaque.value), undefined); assert.deepEqual(opaque.value.properties['a3.planning'], { futureModel: ['preserved'] });
  assert.deepEqual(await readFile(path), future);
});

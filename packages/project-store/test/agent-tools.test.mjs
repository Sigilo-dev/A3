import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { A3_TOOL_SCHEMAS, describeA3Tools, LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch, E1, W1 } from './fixture.mjs';

const RESOURCE = '00000000-0000-4000-8000-000000000004';
const E2 = '00000000-0000-4000-8000-000000000003';
const FOREIGN = '00000000-0000-4000-8000-000000000099';
const windows = { skip: process.platform !== 'win32' };
const worker = fileURLToPath(new URL('./proposal-worker.mjs', import.meta.url));

async function setup(t, profile = 'trabajar', confirmation = () => true, extra = {}) {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'a3-agent-tools', profile, confirmation);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host, ...extra });
  t.after(() => manager.dispose());
  const session = (await manager.openFolder(root)).active;
  assert.ok(session);
  return { root, tempRoot, host, manager, sessionId: session.sessionId, projectId: host.projectId };
}

function scope(extra = {}) {
  return { entityIds: [E1, E2], resourceIds: [RESOURCE], relationIds: [], workspaceIds: [W1], memoryResourceIds: [], ...extra };
}
function call(manager, sessionId, selected, name, args = {}) {
  return manager.createA3ToolSession(sessionId, selected).call({ name, arguments: args });
}

test('A3-031: exposes only typed, project-scoped read, memory-search and validation contracts', windows, async (t) => {
  const c = await setup(t);
  await c.manager.closeActive(c.sessionId);
  await writeFile(join(c.root, 'pages/readme.md'), '# Visión del fixture\n\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n');
  c.sessionId = (await c.manager.openFolder(c.root)).active.sessionId;
  const memory = await c.manager.initializeMemory(c.sessionId);
  const memoryIds = memory.documents.map((item) => item.resourceId);
  const selected = scope({ memoryResourceIds: memoryIds, resourceIds: [RESOURCE, ...memoryIds] });
  const context = await call(c.manager, c.sessionId, selected, 'get_project_context');
  assert.equal(context.ok, true);
  assert.deepEqual(context.value.selection.entities.map((entry) => entry.id), [E1, E2]);
  assert.equal(JSON.stringify(context).includes(c.root), false);
  const entityResults = await call(c.manager, c.sessionId, selected, 'query_entities', { query: 'vision' });
  assert.deepEqual(entityResults.value.results.map((entry) => entry.id), [E1]);
  const memoryResults = await call(c.manager, c.sessionId, selected, 'query_memory', { query: 'proposito' });
  assert.equal(memoryResults.ok, true); assert.ok(memoryResults.value.results.length > 0);
  assert.ok(memoryResults.value.results.every((entry) => entry.provenance.resourceId));
  const resource = await call(c.manager, c.sessionId, selected, 'read_resource', { resourceId: RESOURCE, expectedRevision: 1 });
  assert.equal(resource.ok, true); assert.match(resource.value.content, /Visión del fixture/);
  assert.doesNotMatch(resource.value.content, /sk-proj-abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.match(resource.value.content, /redacted secret-like setting/);
  assert.equal(resource.value.provenance.sha256.length, 64);
  assert.deepEqual(Object.keys(A3_TOOL_SCHEMAS).sort(), ['apply_changes', 'cancel_changes', 'get_project_context', 'query_entities', 'query_memory', 'read_resource', 'undo_changes', 'validate_changes']);
  assert.equal(describeA3Tools().some((tool) => ['update_task', 'run_project_command', 'git_push'].includes(tool.name)), false);
  assert.deepEqual(await call(c.manager, c.sessionId, selected, 'update_task', { taskId: E1, state: 'done' }), { ok: false, error: { code: 'INVALID_SCHEMA' } });
});

test('A3-032: rejects cross-project identifiers, scope expansion and invalid or oversized schemas', windows, async (t) => {
  const c = await setup(t), selected = scope(), oldTools = c.manager.createA3ToolSession(c.sessionId, selected);
  const foreignEntity = await call(c.manager, c.sessionId, selected, 'validate_changes', { operationId: '80000000-0000-4000-8000-000000000101', entityId: FOREIGN, expectedRevision: 1, patch: { title: 'foreign' } });
  assert.deepEqual(foreignEntity, { ok: false, error: { code: 'ID_OUT_OF_SCOPE' } });
  const foreignProject = await call(c.manager, c.sessionId, selected, 'get_project_context', { projectId: '00000000-0000-4000-8000-000000000099' });
  assert.deepEqual(foreignProject, { ok: false, error: { code: 'INVALID_SCHEMA' } });
  for (const invalid of [
    { name: 'read_resource', arguments: { resourceId: 'not-a-uuid', expectedRevision: 1 } },
    { name: 'read_resource', arguments: { resourceId: RESOURCE, expectedRevision: 1, path: 'C:/private' } },
    { name: 'validate_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000102', entityId: E1, expectedRevision: 1, patch: { properties: { token: 'never' } } } }
  ]) assert.deepEqual(await c.manager.createA3ToolSession(c.sessionId, selected).call(invalid), { ok: false, error: { code: 'INVALID_SCHEMA' } });
  const huge = await call(c.manager, c.sessionId, selected, 'query_memory', { query: 'x'.repeat(70 * 1024) });
  assert.deepEqual(huge, { ok: false, error: { code: 'SIZE_LIMIT' } });

  const otherRoot = join(c.tempRoot, 'project-b'); await cp(join(c.tempRoot, 'project'), otherRoot, { recursive: true });
  const manifestPath = join(otherRoot, 'a3.project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.projectId = '00000000-0000-4000-8000-000000000099'; await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await c.host.capabilities.setProfile({ root: otherRoot, projectId: manifest.projectId, profile: 'trabajar' });
  await c.manager.closeActive(c.sessionId); const second = (await c.manager.openFolder(otherRoot)).active;
  assert.ok(second);
  assert.deepEqual(await oldTools.call({ name: 'get_project_context', arguments: {} }),
    { ok: false, error: { code: 'STALE_SESSION' } });
  const contextB = await call(c.manager, second.sessionId, scope(), 'get_project_context');
  assert.equal(contextB.ok, true); assert.equal(contextB.value.project.id, manifest.projectId);
  assert.notEqual(contextB.value.project.id, c.projectId);
});

test('A3-033: validates an expected-revision diff without writing and reports stale revisions', windows, async (t) => {
  const c = await setup(t), selected = scope(), entityPath = join(c.root, '.a3/entities', `${E1}.json`), original = await readFile(entityPath);
  const valid = await call(c.manager, c.sessionId, selected, 'validate_changes', { operationId: '80000000-0000-4000-8000-000000000201', entityId: E1, expectedRevision: 1, patch: { title: 'Visión revisada' } });
  assert.equal(valid.ok, true); assert.equal(valid.value.validated, true); assert.equal(valid.value.persisted, false);
  assert.deepEqual(valid.value.diff.fields, [{ entityId: E1, field: 'title', before: 'Visión', after: 'Visión revisada' }]);
  assert.equal(valid.value.affected[0].expectedRevision, 1); assert.equal(valid.value.permission.capability, 'document.edit');
  assert.equal(valid.value.provenance.entities[0].sourceRevision, 1); assert.equal(valid.value.provenance.entities[0].sourceHash.length, 64);
  assert.deepEqual(await readFile(entityPath), original);
  const stale = await call(c.manager, c.sessionId, selected, 'validate_changes', { operationId: '80000000-0000-4000-8000-000000000202', entityId: E1, expectedRevision: 2, patch: { title: 'stale' } });
  assert.deepEqual(stale, { ok: false, error: { code: 'REVISION_CONFLICT' } });
  assert.deepEqual(await readFile(entityPath), original);
});

test('A3-033: applies a multi-entity proposal through one journaled batch and undoes it through another', windows, async (t) => {
  const c = await setup(t), tools = c.manager.createA3ToolSession(c.sessionId, scope());
  const pathA = join(c.root, '.a3/entities', `${E1}.json`), pathB = join(c.root, '.a3/entities', `${E2}.json`);
  const beforeA = JSON.parse(await readFile(pathA, 'utf8')), beforeB = JSON.parse(await readFile(pathB, 'utf8'));
  const operationId = '80000000-0000-4000-8000-000000000401';
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, changes: [
    { entityId: E1, expectedRevision: 1, patch: { title: 'Propuesta A3' } },
    { entityId: E2, expectedRevision: 1, patch: { tags: ['fixture', 'revisado'] } }
  ] } });
  assert.equal(proposal.ok, true); assert.equal(proposal.value.persisted, false); assert.equal(proposal.value.affected.length, 2);
  assert.equal(proposal.value.permission.mode, 'direct'); assert.equal(proposal.value.permission.decision, 'granted'); assert.equal(proposal.value.diff.fields.length, 2);
  assert.deepEqual(JSON.parse(await readFile(pathA, 'utf8')), beforeA); assert.deepEqual(JSON.parse(await readFile(pathB, 'utf8')), beforeB);
  const applied = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(applied.ok, true); assert.equal(applied.value.status, 'applied'); assert.equal(applied.value.receipt.atomic, false);
  assert.equal(JSON.parse(await readFile(pathA, 'utf8')).revision, 2); assert.equal(JSON.parse(await readFile(pathB, 'utf8')).revision, 2);
  const intent = JSON.parse(await readFile(join(c.root, '.a3/local/transactions', operationId, 'intent.json'), 'utf8'));
  assert.equal(intent.entries.length, 2);
  const repeated = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(repeated.value.status, 'applied'); assert.equal(JSON.parse(await readFile(pathA, 'utf8')).revision, 2);
  const undone = await tools.call({ name: 'undo_changes', arguments: { operationId, undoOperationId: '80000000-0000-4000-8000-000000000402' } });
  assert.equal(undone.ok, true); assert.equal(undone.value.status, 'undone');
  const restoredA = JSON.parse(await readFile(pathA, 'utf8')), restoredB = JSON.parse(await readFile(pathB, 'utf8'));
  assert.equal(restoredA.title, beforeA.title); assert.deepEqual(restoredB.tags, beforeB.tags);
  assert.equal(restoredA.revision, 3); assert.equal(restoredB.revision, 3);
  const repeatedUndo = await tools.call({ name: 'undo_changes', arguments: { operationId, undoOperationId: '80000000-0000-4000-8000-000000000402' } });
  assert.equal(repeatedUndo.value.status, 'undone'); assert.equal(JSON.parse(await readFile(pathA, 'utf8')).revision, 3);
});

test('A3-033: stale member keeps the whole proposal and external bytes without partial application', windows, async (t) => {
  const c = await setup(t), tools = c.manager.createA3ToolSession(c.sessionId, scope());
  const pathA = join(c.root, '.a3/entities', `${E1}.json`), pathB = join(c.root, '.a3/entities', `${E2}.json`);
  const beforeA = await readFile(pathA), external = JSON.parse(await readFile(pathB, 'utf8'));
  const operationId = '80000000-0000-4000-8000-000000000411';
  const preview = await tools.call({ name: 'validate_changes', arguments: { operationId, changes: [
    { entityId: E1, expectedRevision: 1, patch: { title: 'must not partially apply' } },
    { entityId: E2, expectedRevision: 1, patch: { title: 'stale proposal' } }
  ] } });
  assert.equal(preview.ok, true);
  external.title = 'External edit'; external.revision = 2;
  const externalBytes = Buffer.from(JSON.stringify(external, null, 2) + '\n'); await writeFile(pathB, externalBytes);
  const result = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(result.ok, true); assert.equal(result.value.status, 'conflict');
  assert.deepEqual(await readFile(pathA), beforeA); assert.deepEqual(await readFile(pathB), externalBytes);
  const retained = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(retained.value.status, 'conflict'); assert.equal(retained.value.review.diff.fields[0].after, 'must not partially apply');
});

test('A3-033/A3-046: undo is a new journaled transaction and refuses to overwrite a later external edit', windows, async (t) => {
  const c = await setup(t), tools = c.manager.createA3ToolSession(c.sessionId, scope());
  const path = join(c.root, '.a3/entities', `${E1}.json`), operationId = '80000000-0000-4000-8000-000000000416';
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, entityId: E1, expectedRevision: 1, patch: { title: 'Applied first' } } });
  assert.equal(proposal.ok, true); assert.equal((await tools.call({ name: 'apply_changes', arguments: { operationId } })).value.status, 'applied');
  const external = JSON.parse(await readFile(path, 'utf8')); external.title = 'External after apply'; external.revision = 2;
  const externalBytes = Buffer.from(JSON.stringify(external, null, 2) + '\n'); await writeFile(path, externalBytes);
  const undo = await tools.call({ name: 'undo_changes', arguments: { operationId, undoOperationId: '80000000-0000-4000-8000-000000000417' } });
  assert.equal(undo.ok, true); assert.equal(undo.value.status, 'conflict');
  assert.deepEqual(await readFile(path), externalBytes);
});

test('A3-033: Proponer approval shows review details and cancellation preserves the proposal without writes', windows, async (t) => {
  let request;
  const c = await setup(t, 'proponer', async (value) => { if (value.review) { request = value; return false; } return true; });
  const tools = c.manager.createA3ToolSession(c.sessionId, scope()), pathA = join(c.root, '.a3/entities', `${E1}.json`), original = await readFile(pathA);
  const operationId = '80000000-0000-4000-8000-000000000421';
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, entityId: E1, expectedRevision: 1, patch: { title: 'Propuesta pendiente' } } });
  assert.equal(proposal.ok, true, JSON.stringify(proposal)); assert.equal(proposal.value.persisted, false); assert.equal(proposal.value.permission.mode, 'approval'); assert.equal(proposal.value.permission.decision, 'approval-required');
  const cancelled = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.value.status, 'cancelled');
  assert.equal(request.projectId, c.projectId); assert.equal(request.capability, 'document.edit');
  assert.equal(request.review.tool, 'apply_changes'); assert.equal(request.review.affected[0].expectedRevision, 1);
  assert.equal(request.review.diff[0].after, 'Propuesta pendiente'); assert.deepEqual(await readFile(pathA), original);
  const secretTitle = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  const secretProposal = await tools.call({ name: 'validate_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000423', entityId: E1, expectedRevision: 1, patch: { title: secretTitle } } });
  assert.equal(secretProposal.ok, true); assert.match(secretProposal.value.diff.fields[0].after, /redacted token/);
  await tools.call({ name: 'apply_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000423' } });
  assert.match(request.review.diff[0].after, /redacted token/); assert.doesNotMatch(JSON.stringify(request.review), /sk-abcdefghijklmnopqrstuvwxyz012345/);
  const cancelToolProposal = '80000000-0000-4000-8000-000000000422';
  await tools.call({ name: 'validate_changes', arguments: { operationId: cancelToolProposal, entityId: E1, expectedRevision: 1, patch: { title: 'discard' } } });
  assert.equal((await tools.call({ name: 'cancel_changes', arguments: { operationId: cancelToolProposal } })).value.status, 'cancelled');
  assert.equal((await tools.call({ name: 'apply_changes', arguments: { operationId: cancelToolProposal } })).value.status, 'cancelled');
  assert.deepEqual(await readFile(pathA), original);
});

test('A3-033: Consultar can inspect a proposal but cannot apply it', windows, async (t) => {
  const c = await setup(t, 'consultar'), tools = c.manager.createA3ToolSession(c.sessionId, scope());
  const path = join(c.root, '.a3/entities', `${E1}.json`), original = await readFile(path);
  const operationId = '80000000-0000-4000-8000-000000000431';
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, entityId: E1, expectedRevision: 1, patch: { title: 'read-only proposal' } } });
  assert.equal(proposal.ok, true, JSON.stringify(proposal)); assert.equal(proposal.value.persisted, false); assert.equal(proposal.value.permission.decision, 'denied');
  const applied = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.deepEqual(applied, { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'document.edit' } });
  assert.deepEqual(await readFile(path), original);
});

test('A3-031/A3-033: a denied apply is retried only after a newly effective grant re-prepares the proposal', windows, async (t) => {
  const c = await setup(t), tools = c.manager.createA3ToolSession(c.sessionId, scope());
  const path = join(c.root, '.a3/entities', `${E1}.json`), original = await readFile(path), operationId = '80000000-0000-4000-8000-000000000435';
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId, entityId: E1, expectedRevision: 1, patch: { title: 'grant retry' } } });
  assert.equal(proposal.ok, true);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'document.edit', mode: 'deny' });
  assert.deepEqual(await tools.call({ name: 'apply_changes', arguments: { operationId } }),
    { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'document.edit' } });
  assert.deepEqual(await readFile(path), original);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'document.edit', mode: 'direct' });
  const retried = await tools.call({ name: 'apply_changes', arguments: { operationId } });
  assert.equal(retried.ok, true); assert.equal(retried.value.status, 'applied');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).title, 'grant retry');
});

test('A3-033/A3-046: crash during a multi-file apply recovers by journal without partial bytes', windows, async (t) => {
  const c = await setup(t), pathA = join(c.root, '.a3/entities', `${E1}.json`), pathB = join(c.root, '.a3/entities', `${E2}.json`);
  const beforeA = await readFile(pathA), beforeB = await readFile(pathB);
  await c.manager.closeActive(c.sessionId); await c.manager.dispose();
  const child = fork(worker, [c.root, '80000000-0000-4000-8000-000000000441'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, 86, stderr);
  const recoveryHost = await fixtureHost(c.root, 'a3-agent-tools', 'trabajar');
  const recovered = new LocalProjectManager({ stateDirectory: join(c.tempRoot, 'recovered'), host: recoveryHost });
  t.after(() => recovered.dispose());
  const session = (await recovered.openFolder(c.root)).active; assert.ok(session);
  assert.equal(session.mode, 'writer');
  assert.deepEqual(await readFile(pathA), beforeA); assert.deepEqual(await readFile(pathB), beforeB);
  const events = (await readFile(join(c.root, '.a3/local/transactions', '80000000-0000-4000-8000-000000000441', 'progress.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event, 'recovery-rolled-back');
  const tools = recovered.createA3ToolSession(session.sessionId, scope());
  assert.deepEqual(await tools.call({ name: 'apply_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000441' } }),
    { ok: false, error: { code: 'RESOURCE_MISSING' } });
});

test('A3-031/A3-033: read-only profile can preview but the broker blocks apply and reads', windows, async (t) => {
  const c = await setup(t), selected = scope(), tools = c.manager.createA3ToolSession(c.sessionId, selected);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'document.edit', mode: 'deny' });
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000301', entityId: E1, expectedRevision: 1, patch: { title: 'denied' } } });
  assert.equal(proposal.ok, true, JSON.stringify(proposal)); assert.equal(proposal.value.persisted, false); assert.equal(proposal.value.permission.decision, 'denied');
  const applied = await tools.call({ name: 'apply_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000301' } });
  assert.deepEqual(applied, { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'document.edit' } });
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'project.read', mode: 'deny' });
  const read = await tools.call({ name: 'query_entities', arguments: { query: 'visión' } });
  assert.deepEqual(read, { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'project.read' } });
  assert.doesNotMatch(JSON.stringify([proposal, read]), /a3-store-test-|sk-|token value/i);
});

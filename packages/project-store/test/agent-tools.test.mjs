import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { A3_TOOL_SCHEMAS, describeA3Tools, LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch, E1, W1 } from './fixture.mjs';

const RESOURCE = '00000000-0000-4000-8000-000000000004';
const FOREIGN = '00000000-0000-4000-8000-000000000099';
const windows = { skip: process.platform !== 'win32' };

async function setup(t, profile = 'trabajar') {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'a3-agent-tools', profile);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const session = (await manager.openFolder(root)).active;
  assert.ok(session);
  return { root, tempRoot, host, manager, sessionId: session.sessionId, projectId: host.projectId };
}

function scope(extra = {}) {
  return { entityIds: [E1], resourceIds: [RESOURCE], relationIds: [], workspaceIds: [W1], memoryResourceIds: [], ...extra };
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
  assert.deepEqual(context.value.selection.entities.map((entry) => entry.id), [E1]);
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
  assert.deepEqual(Object.keys(A3_TOOL_SCHEMAS).sort(), ['get_project_context', 'query_entities', 'query_memory', 'read_resource', 'validate_changes']);
  assert.equal(describeA3Tools().some((tool) => ['apply_changes', 'run_project_command', 'git_push'].includes(tool.name)), false);
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
  assert.deepEqual(valid.value.diff.fields, [{ field: 'title', before: 'Visión', after: 'Visión revisada' }]);
  assert.equal(valid.value.provenance.sourceRevision, 1); assert.equal(valid.value.provenance.sourceHash.length, 64);
  assert.deepEqual(await readFile(entityPath), original);
  const stale = await call(c.manager, c.sessionId, selected, 'validate_changes', { operationId: '80000000-0000-4000-8000-000000000202', entityId: E1, expectedRevision: 2, patch: { title: 'stale' } });
  assert.deepEqual(stale, { ok: false, error: { code: 'REVISION_CONFLICT' } });
  assert.deepEqual(await readFile(entityPath), original);
});

test('A3-031/A3-033: broker denial blocks reads and change proposals with a structured missing capability', windows, async (t) => {
  const c = await setup(t), selected = scope(), tools = c.manager.createA3ToolSession(c.sessionId, selected);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'document.edit', mode: 'deny' });
  const proposal = await tools.call({ name: 'validate_changes', arguments: { operationId: '80000000-0000-4000-8000-000000000301', entityId: E1, expectedRevision: 1, patch: { title: 'denied' } } });
  assert.deepEqual(proposal, { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'document.edit' } });
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.projectId, capability: 'project.read', mode: 'deny' });
  const read = await tools.call({ name: 'query_entities', arguments: { query: 'visión' } });
  assert.deepEqual(read, { ok: false, error: { code: 'PERMISSION_DENIED', missingCapability: 'project.read' } });
  assert.doesNotMatch(JSON.stringify([proposal, read]), /a3-store-test-|sk-|token value/i);
});

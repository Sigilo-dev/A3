import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRegistry } from '@a3/domain';
import { LocalProjectManager } from '../dist/index.js';
import { projectC4Canvas } from '../dist/c4-canvas.js';
import { scratch, fixtureHost, id, W1 } from './fixture.mjs';

const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e3/c4/scenario.json', import.meta.url), 'utf8'));
test('C4 projection follows the workspace binding instead of guessing between conflicting or unsupported view documents', () => {
  const first = id(9100), second = id(9101);
  const diagram = (id, version = '1.0.0') => ({ kind: 'entity', value: { schemaVersion: '1.0.0', id, revision: 1, type: 'a3.c4.diagram', typeVersion: '1.0.0', title: id,
    tags: [], ports: [], bindings: {}, extensions: {}, properties: { 'a3.diagram.authority': 'a3-model', 'a3.c4.view': { version, kind: 'dynamic', workspaceId: W1, steps: [] } } } });
  const workspace = { kind: 'workspace', value: { schemaVersion: '1.0.0', id: W1, revision: 1, name: 'View', viewport: { x: 0, y: 0, zoom: 1 }, properties: { 'a3.c4.diagram-id': first }, extensions: {} } };
  const snapshot = { records: [workspace, diagram(first), diagram(second)] }, original = structuredClone(snapshot);
  assert.equal(projectC4Canvas(snapshot, defaultRegistry(), W1).current.id, first);
  assert.equal(projectC4Canvas(snapshot, defaultRegistry(), W1).views.length, 1);
  snapshot.records[1] = diagram(first, '2.0.0');
  assert.equal(projectC4Canvas(snapshot, defaultRegistry(), W1).current, null);
  assert.equal(projectC4Canvas(snapshot, defaultRegistry(), W1).views.length, 0);
  assert.deepEqual(snapshot.records[2], original.records[2], 'the unbound document remains intact');
});
test('A3-012 subset: shared C4 elements, hierarchy, five view documents and repeated dynamic steps survive the Windows writer and reopen', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'c4-user');
  const registry = { ...defaultRegistry(), nodeTypes: [scenario.customType] }, stateDirectory = join(tempRoot, 'catalog');
  const manager = new LocalProjectManager({ stateDirectory, host, registry }); t.after(() => manager.dispose());
  let sessionId = (await manager.openFolder(root)).active.sessionId;
  const original = await readFile(join(root, 'readme.md')).catch(() => null);
  const apply = async (ws, operation) => {
    const canvas = await manager.loadCanvasWorkspace(sessionId, ws);
    try { return await manager.changeCanvasC4(sessionId, ws, canvas.revision, operation); }
    catch (error) { error.message = `${operation.action} ${operation.title ?? operation.entityId ?? operation.relationId ?? ''}: ${error.message}`; throw error; }
  };
  const elements = {}, modelPlacements = {}, relationships = {}, views = {};
  for (const [index, e] of scenario.elements.entries()) {
    const canvas = await apply(W1, { action: 'create-element', typeName: e.custom ? scenario.customType.name : `a3.c4.${e.category}`, typeVersion: '1.0.0', title: e.title,
      position: { x: index * 350, y: 50 }, data: { description: e.description ?? '', technology: e.technology ?? '', url: e.url ?? '', external: e.external ?? false,
        ...(e.parent ? { parentId: elements[e.parent] } : {}), ...(e.instanceOf ? { instanceOfId: elements[e.instanceOf] } : {}), ...(e.environment ? { environment: e.environment } : {}) } });
    elements[e.key] = canvas.c4.elements.find((item) => item.title === e.title).id;
    modelPlacements[e.key] = canvas.placements.find((p) => p.entityId === elements[e.key]).id;
  }
  for (const r of scenario.relationships) {
    const canvas = await apply(W1, { action: 'create-relationship', sourcePlacementId: modelPlacements[r.source], targetPlacementId: modelPlacements[r.target], description: r.description, protocol: r.protocol });
    relationships[r.key] = canvas.c4.relationships.find((rel) => rel.description === r.description).id;
  }
  for (const v of scenario.views) {
    let canvas = await apply(W1, { action: 'configure-view', title: v.title, kind: v.kind, newWorkspace: true, scopeEntityId: elements[v.scope], ...(v.environment ? { environment: v.environment } : {}) });
    const info = canvas.c4.views.find((view) => view.title === v.title), placements = {}, relationViews = {}; assert.ok(info);
    const ws = info.workspaceId; views[v.key] = { ...info, placements, relationViews };
    for (const [index, key] of v.elements.entries()) { canvas = await apply(ws, { action: 'show-element', entityId: elements[key], position: { x: index * 360, y: 100 } }); placements[key] = canvas.placements.find((p) => p.entityId === elements[key]).id; }
    for (const key of v.relationships) {
      const r = scenario.relationships.find((r) => r.key === key);
      canvas = await apply(ws, { action: 'show-relationship', relationId: relationships[key], sourcePlacementId: placements[r.source], targetPlacementId: placements[r.target] });
      relationViews[key] = canvas.c4.relationViews.find((rel) => rel.relationId === relationships[key]).id;
    }
    if (v.steps) canvas = await apply(ws, { action: 'set-steps', diagramId: info.id, expectedRevision: canvas.c4.current.revision,
      steps: v.steps.map((key, i) => ({ id: id(8000 + i), order: i + 1, relationViewId: relationViews[key], description: i === 2 ? 'Reintenta' : '' })) });
    assert.equal(canvas.c4.current.data.kind, v.kind); assert.equal(canvas.visualEdges.length, 0);
  }
  const context = await manager.loadCanvasWorkspace(sessionId, views.context.workspaceId), system = context.c4.elements.find((e) => e.id === elements.system);
  await apply(views.context.workspaceId, { action: 'update-element', entityId: system.id, expectedRevision: system.revision, title: 'A3 compartido', tags: ['Local'], data: { description: 'Un solo **modelo**.' } });
  for (const key of ['context', 'containers', 'dynamic']) { const canvas = await manager.loadCanvasWorkspace(sessionId, views[key].workspaceId);
    assert.equal(canvas.entities.find((e) => e.id === system.id).title, 'A3 compartido'); }
  await assert.rejects(apply(views.context.workspaceId, { action: 'update-element', entityId: system.id, expectedRevision: system.revision, title: 'stale', tags: [], data: {} }), (e) => e.code === 'REVISION_CONFLICT');
  const moved = context.placements.find((p) => p.entityId === system.id);
  await manager.updateCanvasPlacement(sessionId, views.context.workspaceId, moved.id, moved.revision, { position: { x: 9999, y: -12 } });
  const other = await manager.loadCanvasWorkspace(sessionId, views.dynamic.workspaceId);
  assert.notEqual(other.placements.find((p) => p.entityId === system.id).position.x, 9999);
  assert.deepEqual(other.c4.current.data.steps.map((step) => step.order), [1, 2, 3]);
  assert.equal(other.c4.current.data.steps[0].relationViewId, other.c4.current.data.steps[2].relationViewId);
  const apiPath = join(root, '.a3/entities', `${elements.api}.json`), bytes = await readFile(apiPath);
  assert.equal(JSON.parse(bytes).properties['a3.c4'].parentId, elements.boundary);
  const instance = JSON.parse(await readFile(join(root, '.a3/entities', `${elements.instance}.json`), 'utf8'));
  assert.equal(instance.properties['a3.c4'].instanceOfId, elements.api);
  await manager.closeActive(sessionId); sessionId = (await manager.openFolder(root)).active.sessionId;
  const reopened = await manager.loadCanvasWorkspace(sessionId, views.dynamic.workspaceId);
  assert.equal(reopened.c4.views.length, 5); assert.equal(reopened.c4.current.id, views.dynamic.id);
  assert.deepEqual(reopened.c4.current.data.steps, other.c4.current.data.steps);
  assert.equal(reopened.c4.elements.find((e) => e.id === elements.api).data.parentId, elements.boundary);
  assert.deepEqual(await readFile(apiPath), bytes);
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'diagram.edit' });
  const api = reopened.c4.elements.find((e) => e.id === elements.api);
  await assert.rejects(apply(views.dynamic.workspaceId, { action: 'update-element', entityId: api.id, expectedRevision: api.revision, title: 'forbidden', tags: [], data: {} }), (e) => e.code === 'PERMISSION_DENIED');
  assert.deepEqual(await readFile(apiPath), bytes);
  if (original) assert.deepEqual(await readFile(join(root, 'readme.md')), original);
  await manager.dispose();
  const withoutPackage = new LocalProjectManager({ stateDirectory, host }); t.after(() => withoutPackage.dispose());
  const missingSession = (await withoutPackage.openFolder(root)).active.sessionId;
  const fallback = await withoutPackage.loadCanvasWorkspace(missingSession, views.dynamic.workspaceId), external = fallback.entities.find((e) => e.id === elements.external);
  assert.equal(external.typeAvailable, false); assert.equal(external.properties['a3.c4'].external, true);
  assert.ok(fallback.c4.relationViews.some((r) => r.targetEntityId === elements.external), 'missing package keeps referenced edges and fallback entity');
});

for (const phase of ['after-intent', 'after-staging', 'after-install', 'before-commit']) {
  test(`C4 view creation recovers deterministically after ${phase} without leaving a corrupt empty workspace`, { skip: process.platform !== 'win32' }, async (t) => {
    const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, `c4-recovery-${phase}`), stateDirectory = join(tempRoot, 'catalog');
    await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'project.recover', mode: 'direct' });
    let injected = false;
    const manager = new LocalProjectManager({ stateDirectory, host, fault: (at, event) => {
      if (!injected && at === phase && (at !== 'after-install' || event.index === 0)) { injected = true; throw new Error('synthetic interruption'); }
    } });
    t.after(() => manager.dispose());
    const session = (await manager.openFolder(root)).active, canvas = await manager.loadCanvasWorkspace(session.sessionId, W1);
    await assert.rejects(manager.changeCanvasC4(session.sessionId, W1, canvas.revision, { action: 'configure-view', title: 'Interrupted', kind: 'dynamic', newWorkspace: true }));
    assert.equal(injected, true); await manager.dispose();
    const recovered = new LocalProjectManager({ stateDirectory, host }); t.after(() => recovered.dispose());
    let active = (await recovered.openFolder(root)).active;
    assert.equal(active.mode, 'writer', JSON.stringify(active.diagnostics));
    let state = await recovered.loadCanvasWorkspace(active.sessionId, W1);
    assert.equal(state.c4.views.length, phase === 'before-commit' ? 1 : 0);
    const directories = await readdir(join(root, '.a3/workspaces'));
    assert.equal(directories.length, phase === 'before-commit' ? 3 : 2);
    await recovered.closeActive(active.sessionId); active = (await recovered.openFolder(root)).active;
    state = await recovered.loadCanvasWorkspace(active.sessionId, W1);
    assert.equal(state.c4.views.length, phase === 'before-commit' ? 1 : 0, 'repeated recovery is idempotent');
  });
}

test('C4 rollback preserves external contents inside a newly staged workspace and reports a recovery conflict', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'c4-external-dir'), stateDirectory = join(tempRoot, 'catalog');
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'project.recover', mode: 'direct' });
  const original = new Set(await readdir(join(root, '.a3/workspaces'))); let marker;
  const manager = new LocalProjectManager({ stateDirectory, host, fault: async (phase) => {
    if (phase !== 'after-staging') return;
    const added = (await readdir(join(root, '.a3/workspaces'))).find((name) => !original.has(name));
    marker = join(root, '.a3/workspaces', added, 'external.txt'); await writeFile(marker, 'external bytes'); throw new Error('synthetic interruption');
  } }); t.after(() => manager.dispose());
  const session = (await manager.openFolder(root)).active, canvas = await manager.loadCanvasWorkspace(session.sessionId, W1);
  await assert.rejects(manager.changeCanvasC4(session.sessionId, W1, canvas.revision, { action: 'configure-view', title: 'Interrupted', kind: 'dynamic', newWorkspace: true }));
  await manager.dispose();
  const recovered = new LocalProjectManager({ stateDirectory, host }); t.after(() => recovered.dispose());
  const active = (await recovered.openFolder(root)).active;
  assert.equal(active.mode, 'read-only'); assert.equal(await readFile(marker, 'utf8'), 'external bytes');
  assert.ok(active.diagnostics.some((message) => message.includes('recuper') || message.includes('conserv')));
});

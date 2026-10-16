import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager, createProjectCapabilityBroker } from '../dist/index.js';
import { fixtureHost, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
async function setup(t, extra = {}) {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'project-lifecycle');
  const options = { stateDirectory: join(tempRoot, 'catalog'), host, ...extra };
  const managers = [];
  const manager = (overrides = {}) => { const value = new LocalProjectManager({ ...options, ...overrides }); managers.push(value); return value; };
  t.after(async () => { for (const value of managers) await value.dispose(); });
  return { root, tempRoot, host, options, manager };
}

test('A3-001: offline create, rename, close and reopen persist Principal, UUIDs and local recents', windows, async (t) => {
  const { tempRoot, manager } = await setup(t);
  const first = manager();
  const preview = await first.previewCreate(tempRoot, 'Sin internet');
  assert.equal(preview.preview.atomic, false);
  await assert.rejects(readFile(join(tempRoot, 'Sin internet', 'a3.project.json')), { code: 'ENOENT' });
  const opened = await first.confirmInitialization(preview.preview.token);
  const { sessionId, projectId, root } = opened.active;
  assert.equal(opened.active.mode, 'writer');
  assert.deepEqual(opened.active.workspaces.map((w) => w.name), ['Principal']);
  await assert.rejects(readFile(join(root, '.git', 'HEAD')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, '.a3', '.gitignore'), 'utf8'), '/local/\n');
  const renamed = await first.renameActive(sessionId, 'Nombre definitivo');
  assert.equal(renamed.active.name, 'Nombre definitivo');
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  assert.equal(manifest.revision, 2);
  assert.equal(manifest.projectId, projectId);
  await first.closeActive(sessionId); await first.dispose();
  const second = manager();
  const state = await second.getState();
  assert.equal(state.active, null);
  assert.equal(state.recents[0].available, true);
  const reopened = await second.openRecent(state.recents[0].id);
  assert.equal(reopened.active.projectId, projectId);
  assert.equal(reopened.active.name, 'Nombre definitivo');
  assert.notEqual(reopened.active.sessionId, sessionId);
  await assert.rejects(second.renameActive(sessionId, 'Stale'), { code: 'STALE_SESSION' });
  await assert.rejects(second.previewCreate(tempRoot, 'Sin internet'), { code: 'DUPLICATE_NAME' });
  const catalog = await readFile(join(tempRoot, 'catalog', 'projects.json'), 'utf8');
  for (const secret of ['credentials', 'cookie', 'token', 'grant']) assert.equal(catalog.includes(secret), false);
});

test('A3-002: cancel incorporation adds no metadata; confirming preserves every prior byte', windows, async (t) => {
  const { tempRoot, manager } = await setup(t);
  const root = join(tempRoot, 'Existing'); await mkdir(root);
  const old = { 'README.md': Buffer.from('existing\r\n'), '.gitignore': Buffer.from('# user\r\n'), 'photo.bin': Buffer.from([0, 255, 1, 13, 10]) };
  for (const [path, bytes] of Object.entries(old)) await writeFile(join(root, path), bytes);
  const app = manager(); const preview = await app.openFolder(root);
  assert.equal(preview.preview.kind, 'incorporate');
  await app.cancelPreview(preview.preview.token);
  await assert.rejects(readFile(join(root, 'a3.project.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, '.a3', '.gitignore')), { code: 'ENOENT' });
  const again = await app.openFolder(root);
  const opened = await app.confirmInitialization(again.preview.token);
  assert.equal(opened.active.workspaces[0].name, 'Principal');
  for (const [path, bytes] of Object.entries(old)) assert.deepEqual(await readFile(join(root, path)), bytes);
});

test('A3-003: moved recent is unavailable, never recreated, and relocation verifies project UUID', windows, async (t) => {
  const { root: other, tempRoot, manager } = await setup(t);
  const app = manager(); const preview = await app.previewCreate(tempRoot, 'Portable');
  const opened = await app.confirmInitialization(preview.preview.token);
  const oldRoot = opened.active.root; const projectId = opened.active.projectId; const recentId = opened.recents[0].id;
  await writeFile(join(oldRoot, 'pages', 'source.md'), Buffer.from('# Original\r\n'));
  await app.closeActive(opened.active.sessionId);
  const moved = join(tempRoot, 'Moved'); await rename(oldRoot, moved);
  assert.equal((await app.getState()).recents[0].available, false);
  await assert.rejects(app.openRecent(recentId), { code: 'ENOENT' });
  await assert.rejects(readFile(join(oldRoot, 'a3.project.json')), { code: 'ENOENT' });
  await assert.rejects(app.relocateRecent(recentId, other), { code: 'PROJECT_ID_MISMATCH' });
  const located = await app.relocateRecent(recentId, moved);
  assert.equal(located.active.projectId, projectId);
  assert.equal(located.recents[0].id, recentId);
  assert.equal(located.recents.length, 1);
  assert.deepEqual(await readFile(join(moved, 'pages', 'source.md')), Buffer.from('# Original\r\n'));
});

test('unknown format opens read-only and switching rejects an old session without rewriting bytes', windows, async (t) => {
  const { root, tempRoot, manager } = await setup(t);
  const app = manager(); const original = await app.openFolder(root);
  const path = join(root, 'a3.project.json');
  await app.closeActive(original.active.sessionId);
  const unknown = Buffer.from((await readFile(path, 'utf8')).replace('"formatVersion": "1.0.0"', '"formatVersion": "2.0.0"'));
  await writeFile(path, unknown);
  const inspected = await app.openFolder(root);
  assert.equal(inspected.active.mode, 'read-only');
  assert.equal(inspected.active.format, '2.0.0');
  assert.deepEqual(await readFile(path), unknown);
  const preview = await app.previewCreate(tempRoot, 'Another');
  const next = await app.confirmInitialization(preview.preview.token);
  assert.notEqual(next.active.sessionId, inspected.active.sessionId);
  await assert.rejects(app.renameActive(inspected.active.sessionId, 'wrong project'), { code: 'STALE_SESSION' });
});

test('E2-B2: spatial groups manage subgroups and strokes, move once, collapse across reopen, and keep visual edges canonical', windows, async (t) => {
  const { root, manager } = await setup(t);
  const app = manager();
  const opened = await app.openFolder(root);
  const sessionId = opened.active.sessionId, workspaceId = opened.active.workspaces[0].id;
  let view = await app.loadCanvasWorkspace(sessionId, workspaceId);
  const placements = [...view.placements];
  assert.equal(placements.length >= 2, true);
  const originalEdge = structuredClone(view.visualEdges[0]);
  const drawingResult = await app.createCanvasDrawing(sessionId, workspaceId, view.revision, [{ x: 20, y: 30, pressure: 0.6 }],
    { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }, { 'a3.ui.stroke.color': '#c3ed82' });
  view = drawingResult;
  const drawing = view.drawings[0];
  view = await app.createCanvasGroup(sessionId, workspaceId, view.revision, 'Grupo principal', [
    { kind: 'placement', id: placements[0].id }, { kind: 'drawing', id: drawing.id }
  ]);
  let parent = view.groups.find((group) => group.name === 'Grupo principal');
  assert.ok(parent);
  view = await app.createCanvasGroup(sessionId, workspaceId, view.revision, 'Subgrupo', [{ kind: 'placement', id: placements[1].id }]);
  const child = view.groups.find((group) => group.name === 'Subgrupo');
  assert.ok(child);
  parent = view.groups.find((group) => group.id === parent.id);
  const drawingMember = parent.members.find((member) => member.kind === 'drawing');
  view = await app.setCanvasGroupMembers(sessionId, workspaceId, parent.id, parent.revision, parent.members.filter((member) => member.kind !== 'drawing'));
  assert.ok(view.drawings.some((item) => item.id === drawing.id), 'ungrouping removes only a view reference, never the drawing document');
  parent = view.groups.find((group) => group.id === parent.id);
  view = await app.setCanvasGroupMembers(sessionId, workspaceId, parent.id, parent.revision, [...parent.members, drawingMember, { kind: 'group', id: child.id }]);
  parent = view.groups.find((group) => group.id === parent.id);
  view = await app.renameCanvasGroup(sessionId, workspaceId, parent.id, parent.revision, 'Plan revisado');
  parent = view.groups.find((group) => group.id === parent.id);
  assert.equal(parent.name, 'Plan revisado');
  await assert.rejects(app.setCanvasGroupMembers(sessionId, workspaceId, child.id, child.revision, [{ kind: 'group', id: parent.id }]), /ciclo/i);
  await assert.rejects(app.renameCanvasGroup(sessionId, workspaceId, parent.id, parent.revision - 1, 'Conflicto'), { code: 'REVISION_CONFLICT' });

  const beforeFirst = view.placements.find((item) => item.id === placements[0].id).position;
  const beforeSecond = view.placements.find((item) => item.id === placements[1].id).position;
  view = await app.moveCanvasGroup(sessionId, workspaceId, parent.id, parent.revision, { x: 40, y: 25 });
  assert.deepEqual(view.placements.find((item) => item.id === placements[0].id).position, { x: beforeFirst.x + 40, y: beforeFirst.y + 25 });
  assert.deepEqual(view.placements.find((item) => item.id === placements[1].id).position, { x: beforeSecond.x + 40, y: beforeSecond.y + 25 });
  assert.deepEqual(view.drawings[0].points, [{ x: 60, y: 55, pressure: 0.6 }]);
  assert.equal(view.visualEdges[0].sourcePlacementId, originalEdge.sourcePlacementId);
  assert.equal(view.visualEdges[0].targetPlacementId, originalEdge.targetPlacementId);

  parent = view.groups.find((group) => group.id === parent.id);
  view = await app.setCanvasGroupCollapsed(sessionId, workspaceId, parent.id, parent.revision, true);
  assert.equal(view.groups.find((group) => group.id === parent.id).collapsed, true);
  const recentId = opened.recents[0].id;
  await app.closeActive(sessionId);
  const reopened = await app.openRecent(recentId);
  view = await app.loadCanvasWorkspace(reopened.active.sessionId, workspaceId);
  parent = view.groups.find((group) => group.name === 'Plan revisado');
  assert.equal(parent.collapsed, true);
  assert.equal(view.visualEdges[0].sourcePlacementId, originalEdge.sourcePlacementId);
  view = await app.setCanvasGroupCollapsed(reopened.active.sessionId, workspaceId, parent.id, parent.revision, false);
  assert.equal(view.groups.find((group) => group.id === parent.id).collapsed, false);
  assert.deepEqual(view.placements.find((item) => item.id === placements[0].id).position, { x: beforeFirst.x + 40, y: beforeFirst.y + 25 });
});

for (const [phase, index] of [['after-staging', undefined], ['after-install', 0], ['after-install', 1]]) {
  test(`bootstrap uses D1 recovery after interruption at ${phase}:${index ?? '-'}`, windows, async (t) => {
    const { tempRoot, manager } = await setup(t);
    let triggered = false;
    const first = manager({ fault: (point, event) => { if (!triggered && point === phase && (index === undefined || event.index === index)) { triggered = true; throw new Error('simulated interruption'); } } });
    const preview = await first.previewCreate(tempRoot, 'Interrupted');
    await assert.rejects(first.confirmInitialization(preview.preview.token), /simulated interruption/);
    assert.equal(await readFile(join(tempRoot, 'Interrupted', '.a3', '.gitignore'), 'utf8'), '/local/\n');
    await first.dispose();
    const second = manager();
    const root = join(tempRoot, 'Interrupted');
    let recovered = await second.openFolder(root);
    if (recovered.preview) recovered = await second.confirmInitialization(recovered.preview.token);
    assert.equal(recovered.active.name, 'Interrupted');
    assert.equal(recovered.active.workspaces[0].name, 'Principal');
    const bytes = await readFile(join(root, 'a3.project.json'));
    await second.closeActive(recovered.active.sessionId);
    const repeated = await second.openFolder(root);
    assert.equal(repeated.active.workspaces.length, 1);
    assert.deepEqual(await readFile(join(root, 'a3.project.json')), bytes);
  });
}

test('initialization fails closed on changed destination, metadata collision and denied approval', windows, async (t) => {
  const { tempRoot, manager, options } = await setup(t);
  const app = manager(); const preview = await app.previewCreate(tempRoot, 'Race');
  await mkdir(join(tempRoot, 'Race')); await writeFile(join(tempRoot, 'Race', 'external.txt'), 'external');
  await assert.rejects(app.confirmInitialization(preview.preview.token), { code: 'DUPLICATE_NAME' });
  assert.equal(await readFile(join(tempRoot, 'Race', 'external.txt'), 'utf8'), 'external');
  await mkdir(join(tempRoot, 'Race', '.a3'));
  await assert.rejects(app.openFolder(join(tempRoot, 'Race')), { code: 'METADATA_CONFLICT' });
  const deniedHost = { authenticatedActor: options.host.authenticatedActor, capabilities: createProjectCapabilityBroker({ stateDirectory: join(tempRoot, 'deny-grants'), authenticatedActor: options.host.authenticatedActor, confirmUserAction: () => false }) };
  const denied = manager({ stateDirectory: join(tempRoot, 'deny-catalog'), host: deniedHost });
  const blocked = await denied.previewCreate(tempRoot, 'Denied');
  await assert.rejects(denied.confirmInitialization(blocked.preview.token), { code: 'PERMISSION_DENIED' });
  await assert.rejects(readFile(join(tempRoot, 'Denied', 'a3.project.json')), { code: 'ENOENT' });
});

test('switching flushes a staged project name and a failed save keeps the previous session', windows, async (t) => {
  const { root, tempRoot, manager } = await setup(t);
  const app = manager(); const first = await app.openFolder(root);
  await app.stageName(first.active.sessionId, 'Saved when switching');
  const preview = await app.previewCreate(tempRoot, 'Next');
  await app.confirmInitialization(preview.preview.token);
  assert.equal(JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8')).name, 'Saved when switching');
  const active = (await app.getState()).active;
  await app.stageName(active.sessionId, '');
  await assert.rejects(app.closeActive(active.sessionId), { code: 'INVALID_NAME' });
  assert.equal((await app.getState()).active.sessionId, active.sessionId);
  await app.stageName(active.sessionId, active.name);
  await app.closeActive(active.sessionId);
});

test('local catalog has a single owner; corrupt catalog bytes remain intact and shutdown still works', windows, async (t) => {
  const { tempRoot, manager } = await setup(t);
  const first = manager(); await first.getState();
  const second = manager(); await assert.rejects(second.getState(), { code: 'LOCAL_CATALOG_BUSY' });
  await first.shutdown();
  await writeFile(join(tempRoot, 'catalog', 'projects.json'), '{ truncated');
  await assert.rejects(second.getState(), { code: 'LOCAL_CATALOG_INVALID' });
  await second.shutdown();
  assert.equal(await readFile(join(tempRoot, 'catalog', 'projects.json'), 'utf8'), '{ truncated');
});

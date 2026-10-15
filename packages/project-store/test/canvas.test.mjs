import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, W1 } from './fixture.mjs';
const windows = { skip: process.platform !== 'win32' };
const W2 = '00000000-0000-4000-8000-000000000007';
const pathOf = (root, id) => join(root, '.a3', 'workspaces', id, 'workspace.json');

test('A3-006/007: viewport drafts flush on close, remain independent per workspace and reopen without drift', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const document = JSON.parse(await readFile(pathOf(root, W1), 'utf8'));
  document.viewport['future.camera'] = { retained: true }; document.extensions['future.keep'] = ['unknown'];
  await writeFile(pathOf(root, W1), JSON.stringify(document, null, 2) + '\n');
  const host = await fixtureHost(root, 'canvas-user');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const first = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const second = await manager.loadCanvasWorkspace(active.sessionId, W2);
  const v1 = { x: -1e12 + 0.125, y: 1e12 - 0.25, zoom: 0.73 };
  const v2 = { x: 12.125, y: -45.75, zoom: 8 };
  await manager.stageCanvasViewport(active.sessionId, W1, first.revision, v1);
  await manager.stageCanvasViewport(active.sessionId, W2, second.revision, v2);
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).pending, true);
  // No canonical write per pointer event.
  assert.deepEqual(JSON.parse(await readFile(pathOf(root, W1), 'utf8')).viewport, document.viewport);
  await manager.closeActive(active.sessionId);
  const reopened = (await manager.openFolder(root)).active;
  assert.deepEqual((await manager.loadCanvasWorkspace(reopened.sessionId, W1)).viewport, v1);
  assert.deepEqual((await manager.loadCanvasWorkspace(reopened.sessionId, W2)).viewport, v2);
  const saved = await readFile(pathOf(root, W1)); const value = JSON.parse(saved);
  assert.deepEqual(value.viewport['future.camera'], { retained: true }); assert.deepEqual(value.extensions, document.extensions);
  await manager.closeActive(reopened.sessionId); await manager.openFolder(root);
  assert.deepEqual(await readFile(pathOf(root, W1)), saved, 'load/close without interaction preserves bytes and revision');
  await assert.rejects(manager.loadCanvasWorkspace(active.sessionId, W1), { code: 'STALE_SESSION' });
});
test('viewport writes enforce revisions, broker revocation and read-only inspection', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'canvas-permissions');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active; const base = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const before = await readFile(pathOf(root, W1));
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision + 1, { x: 1, y: 2, zoom: 1 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: NaN, y: 2, zoom: 1 }), { code: 'INVALID_VIEWPORT' });
  await manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 1, y: 2, zoom: 1 });
  assert.equal(await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' }), true);
  await assert.rejects(manager.flushCanvasWorkspace(active.sessionId, W1));
  assert.deepEqual(await readFile(pathOf(root, W1)), before);
  assert.equal((await manager.loadCanvasWorkspace(active.sessionId, W1)).canWrite, false);
  await manager.discardCanvasViewport(active.sessionId, W1);
  await assert.rejects(manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 1, y: 2, zoom: 1 }), { code: 'PERMISSION_DENIED' });
});

test('an external workspace replacement conflicts with a pending viewport and preserves external bytes', windows, async (t) => {
  const { root, tempRoot } = await scratch(t); const host = await fixtureHost(root, 'canvas-conflict');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active; const base = await manager.loadCanvasWorkspace(active.sessionId, W1);
  await manager.stageCanvasViewport(active.sessionId, W1, base.revision, { x: 7.125, y: -8.5, zoom: 1.25 });
  const file = pathOf(root, W1); const external = JSON.parse(await readFile(file, 'utf8'));
  external.revision++; external.name = 'External revision'; const bytes = Buffer.from(JSON.stringify(external) + '\n'); await writeFile(file, bytes);
  await assert.rejects(manager.flushCanvasWorkspace(active.sessionId, W1));
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await manager.getState()).active.pendingViewport, true);
  await manager.discardCanvasViewport(active.sessionId, W1);
});

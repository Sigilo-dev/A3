import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager, openProjectService } from '../dist/index.js';
import { validWorkspaceSession } from '../dist/workspace-session.js';
import { scratch, fixtureHost, E1, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
async function setup(t) {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'focus-session');
  const options = { stateDirectory: join(tempRoot, 'catalog'), host };
  const manager = new LocalProjectManager(options); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  return { root, tempRoot, host, options, manager, active };
}
const load = (manager, id) => manager.workspaceSession(id, { action: 'load' });
const apply = (manager, id, state, action) => manager.workspaceSession(id, action, state.revision);

test('A3-004/009: repeat opening activates, another view shares IDs and keeps independent view state; close never deletes content', windows, async (t) => {
  const { root, manager, active } = await setup(t);
  let state = await load(manager, active.sessionId); const workspace = state.selectedId;
  state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  const first = state.tabs[1], path = (await manager.pageReference(active.sessionId, first.id)).relativePath;
  const bytes = await readFile(join(root, path));
  assert.equal(state.tabs[0].id, workspace);
  state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  assert.equal(state.tabs.length, 2); assert.equal(state.selectedId, first.id);
  state = await apply(manager, active.sessionId, state, { action: 'view', tabId: first.id, view: { mode: 'source', scrollTop: 321, scrollLeft: 3, selection: { anchor: 2, head: 9 } } });
  state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1, anotherView: true });
  const second = state.tabs[2]; assert.equal(second.entityId, first.entityId); assert.equal(second.resourceId, first.resourceId); assert.notEqual(second.id, first.id);
  assert.equal(second.view.scrollTop, 0); assert.equal(state.tabs[1].view.scrollTop, 321);
  state = await apply(manager, active.sessionId, state, { action: 'activate', tabId: workspace });
  state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1, anotherView: true });
  assert.equal(state.tabs[1].id, state.selectedId, 'new view is immediately right of current workspace');
  state = await apply(manager, active.sessionId, state, { action: 'close', tabId: first.id });
  assert.equal(state.tabs.some((tab) => tab.id === first.id), false); assert.deepEqual(await readFile(join(root, path)), bytes);
  await assert.rejects(manager.workspaceSession(active.sessionId, { action: 'close', tabId: second.id }, 0), { code: 'SESSION_REVISION_CONFLICT' });
});

test('application restart restores selected tab, order, page cursor and local canvas viewport without persisting tokens or source', windows, async (t) => {
  const { root, options, manager, active } = await setup(t);
  let state = await load(manager, active.sessionId); const workspace = state.selectedId;
  state = await apply(manager, active.sessionId, state, { action: 'view', tabId: workspace, view: { x: -21.25, y: 543.5, zoom: 0.7 } });
  state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  const page = state.selectedId;
  state = await apply(manager, active.sessionId, state, { action: 'view', tabId: page, view: { mode: 'source', scrollTop: 400, scrollLeft: 6, selection: { anchor: 12, head: 14 } } });
  state = await apply(manager, active.sessionId, state, { action: 'reorder', tabIds: [page, workspace] });
  await manager.shutdown();
  const reopened = new LocalProjectManager(options); t.after(() => reopened.dispose());
  const restoredProject = (await reopened.restoreLastProject()).active;
  assert.equal(restoredProject.root, root); assert.notEqual(restoredProject.sessionId, active.sessionId);
  assert.deepEqual(await load(reopened, restoredProject.sessionId), state);
  const raw = await readFile(join(options.stateDirectory, 'workspace-sessions', (await readdir(join(options.stateDirectory, 'workspace-sessions')))[0]), 'utf8');
  assert.equal(raw.includes(active.sessionId), false); assert.equal(raw.includes('content'), false); assert.equal(raw.includes('token'), false);
  await assert.rejects(reopened.workspaceSession(active.sessionId, { action: 'load' }), { code: 'STALE_SESSION' });
});

test('project clone with the same UUID gets separate tab state; explicit close suppresses auto reopen', windows, async (t) => {
  const { root, tempRoot, manager, active, options } = await setup(t);
  let state = await load(manager, active.sessionId); state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  const clone = join(tempRoot, 'clone'); await cp(root, clone, { recursive: true });
  const other = (await manager.openFolder(clone)).active;
  const isolated = await load(manager, other.sessionId); assert.equal(isolated.tabs.length, 1); assert.notEqual(isolated.rootIdentity, state.rootIdentity);
  const original = (await manager.openFolder(root)).active; assert.deepEqual(await load(manager, original.sessionId), state);
  await manager.shutdown();
  // Explicit close suppresses automatic reopening but keeps the per-project tabs on the next manual open.
  const reopened = new LocalProjectManager(options); t.after(() => reopened.dispose()); await reopened.openFolder(root);
  const id = (await reopened.getState()).active.sessionId; await reopened.closeActive(id);
  await reopened.shutdown();
  const third = new LocalProjectManager(options); t.after(() => third.dispose());
  assert.equal((await third.restoreLastProject()).active, null);
});

test('missing Markdown restores its reference and explicit locate journals only descriptor repair; selected bytes remain exact', windows, async (t) => {
  const { root, manager, active, options } = await setup(t);
  let state = await load(manager, active.sessionId); state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  const page = state.tabs[1], reference = await manager.pageReference(active.sessionId, page.id), original = await readFile(join(root, reference.relativePath));
  await manager.shutdown();
  await mkdir(join(root, 'located'), { recursive: true }); await rename(join(root, reference.relativePath), join(root, 'located', 'page.md'));
  const reopened = new LocalProjectManager(options); t.after(() => reopened.dispose()); const resumed = (await reopened.restoreLastProject()).active;
  assert.equal((await load(reopened, resumed.sessionId)).selectedId, page.id);
  await assert.rejects(reopened.openMarkdownDocument(resumed.sessionId, page.entityId, page.resourceId), /recurso|archivo/i);
  assert.deepEqual(await reopened.pageReference(resumed.sessionId, page.id), reference);
  await assert.rejects(readFile(join(root, reference.relativePath)), { code: 'ENOENT' });
  await reopened.locatePageResource(resumed.sessionId, page.id, join(root, 'located/page.md'));
  assert.deepEqual(await readFile(join(root, 'located/page.md')), original);
  const fixed = await reopened.pageReference(resumed.sessionId, page.id); assert.equal(fixed.resourceId, page.resourceId); assert.equal(fixed.relativePath, 'located/page.md');
  const doc = await reopened.openMarkdownDocument(resumed.sessionId, page.entityId, page.resourceId); assert.ok(doc.content);
});

test('invalid local session and extra secret fields are rejected without replacing original bytes', windows, async (t) => {
  const { options, manager, active } = await setup(t);
  let state = await load(manager, active.sessionId); state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  assert.equal(validWorkspaceSession({ ...state, token: 'no' }), false);
  await manager.shutdown(); const path = join(options.stateDirectory, 'workspace-sessions', (await readdir(join(options.stateDirectory, 'workspace-sessions')))[0]);
  const corrupt = Buffer.from('{truncated'); await writeFile(path, corrupt);
  const reopened = new LocalProjectManager(options); t.after(() => reopened.dispose()); const project = (await reopened.restoreLastProject()).active;
  await assert.rejects(load(reopened, project.sessionId), { code: 'LOCAL_SESSION_INVALID' }); assert.deepEqual(await readFile(path), corrupt);
});

test('automatic startup respects revoked read access and retains the recent reference', windows, async (t) => {
  const { root, manager, options, host } = await setup(t);
  await manager.shutdown();
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'project.read' });
  const reopened = new LocalProjectManager(options); t.after(() => reopened.dispose());
  const state = await reopened.restoreLastProject(); assert.equal(state.active, null); assert.ok(state.restoreNotice); assert.equal(state.recents[0].root, root);
});

test('locating a missing page rejects escapes, stale selected bytes and revoked editing without replacing source or descriptor', windows, async (t) => {
  const { root, tempRoot, host, manager, active } = await setup(t);
  let state = await load(manager, active.sessionId); state = await apply(manager, active.sessionId, state, { action: 'open-page', entityId: E1 });
  const page = state.tabs[1], ref = await manager.pageReference(active.sessionId, page.id), descriptorPath = join(root, '.a3/resources', page.resourceId + '.json');
  const before = await readFile(descriptorPath); await manager.shutdown();
  await rename(join(root, ref.relativePath), join(root, 'located.md')); await writeFile(join(tempRoot, 'outside.md'), '# outside\n');
  const lease = await openProjectService(root, { host }); assert.equal(lease.ok, true); t.after(() => lease.value.close());
  const service = lease.value.service, request = { operationId: '92000000-0000-4000-8000-000000000001', resourceId: page.resourceId, expectedRevision: 1, path: 'located.md' };
  assert.equal((await service.prepareResourceRelocation({ ...request, path: '../outside.md' })).ok, false);
  const plan = await service.prepareResourceRelocation(request); assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  await writeFile(join(root, 'located.md'), '# newer selected bytes\n');
  assert.equal((await service.commit(plan.value)).ok, false); assert.deepEqual(await readFile(descriptorPath), before);
  await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' });
  assert.equal((await service.prepareResourceRelocation({ ...request, operationId: '92000000-0000-4000-8000-000000000002' })).ok, false);
  assert.equal(await readFile(join(root, 'located.md'), 'utf8'), '# newer selected bytes\n'); assert.deepEqual(await readFile(descriptorPath), before);
});

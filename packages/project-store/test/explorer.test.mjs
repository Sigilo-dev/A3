import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
async function managerFor(t, root, tempRoot, host) {
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  return { manager, active: (await manager.openFolder(root)).active };
}

test('A3-002: explorer pages directories incrementally and hides local metadata, secrets and ignored content', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  await writeFile(join(root, '.gitignore'), 'private/\n*.cache\n');
  await writeFile(join(root, '.env.local'), 'do not display');
  await writeFile(join(root, 'private.cache'), 'ignored');
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private', 'secret.md'), 'ignored');
  await mkdir(join(root, 'pages'), { recursive: true });
  for (let index = 0; index < 103; index++) await writeFile(join(root, 'pages', `item-${index}.md`), `# ${index}\n`);
  const host = await fixtureHost(root, 'explorer-page-test');
  const { manager, active } = await managerFor(t, root, tempRoot, host);
  const rootPage = await manager.listExplorer(active.sessionId);
  assert.equal(rootPage.entries.some((entry) => entry.name === '.a3' || entry.name === '.env.local' || entry.name === 'private' || entry.name === 'private.cache'), false);
  const pages = rootPage.entries.find((entry) => entry.name === 'pages');
  const first = await manager.listExplorer(active.sessionId, pages.id);
  assert.equal(first.entries.length, 100);
  assert.ok(first.nextCursor);
  const second = await manager.listExplorer(active.sessionId, pages.id, first.nextCursor);
  assert.equal(second.entries.length, 4);
  assert.equal(second.entries[0].name, 'item-97.md');
});

test('file create, rename and duplicate are journaled and rename preserves the resource ID', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'explorer-write-test');
  const { manager, active } = await managerFor(t, root, tempRoot, host);
  await manager.createExplorerItem('project-root', 'idea.md', 'file', active.sessionId);
  let listing = await manager.listExplorer(active.sessionId);
  const created = listing.entries.find((entry) => entry.name === 'idea.md');
  assert.ok(created?.resourceId);
  assert.equal(await manager.copyExplorerPath(created.id, 'relative', active.sessionId), 'idea.md');
  assert.equal(await manager.copyExplorerPath(created.id, 'absolute', active.sessionId), join(root, 'idea.md'));
  await writeFile(join(root, 'swapped.md'), 'before');
  await writeFile(join(root, 'replacement.tmp'), 'after');
  const beforeSwap = (await manager.listExplorer(active.sessionId)).entries.find((entry) => entry.name === 'swapped.md');
  await rm(join(root, 'swapped.md')); await rename(join(root, 'replacement.tmp'), join(root, 'swapped.md'));
  await assert.rejects(manager.copyExplorerPath(beforeSwap.id, 'relative', active.sessionId), { code: 'REVISION_CONFLICT' });
  const resourceId = created.resourceId;
  await manager.renameExplorerItem(created.id, 'renamed.md', active.sessionId);
  listing = await manager.listExplorer(active.sessionId);
  const renamed = listing.entries.find((entry) => entry.name === 'renamed.md');
  assert.equal(renamed?.resourceId, resourceId);
  assert.deepEqual(await readFile(join(root, 'renamed.md')), Buffer.alloc(0));
  await assert.rejects(readFile(join(root, 'idea.md')), { code: 'ENOENT' });
  await manager.duplicateExplorerItem(renamed.id, 'copy.md', active.sessionId);
  listing = await manager.listExplorer(active.sessionId);
  const copy = listing.entries.find((entry) => entry.name === 'copy.md');
  assert.ok(copy?.resourceId);
  assert.notEqual(copy.resourceId, resourceId);
  assert.deepEqual(await readFile(join(root, 'copy.md')), Buffer.alloc(0));
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'delete', mode: 'direct' }), true);
  const preview = await manager.previewExplorerDelete(copy.id, active.sessionId);
  assert.equal(preview.deletable, true);
  await manager.cancelExplorerDelete(preview.token, active.sessionId);
  assert.deepEqual(await readFile(join(root, 'copy.md')), Buffer.alloc(0));

  await manager.createExplorerItem('project-root', 'plans', 'directory', active.sessionId);
  let rootListing = await manager.listExplorer(active.sessionId);
  const plans = rootListing.entries.find((entry) => entry.name === 'plans');
  await manager.createExplorerItem(plans.id, 'inside.md', 'file', active.sessionId);
  let nested = await manager.listExplorer(active.sessionId, plans.id);
  const inside = nested.entries.find((entry) => entry.name === 'inside.md');
  const insideResourceId = inside.resourceId;
  await manager.renameExplorerItem(plans.id, 'plans-renamed', active.sessionId);
  rootListing = await manager.listExplorer(active.sessionId);
  const renamedPlans = rootListing.entries.find((entry) => entry.name === 'plans-renamed');
  nested = await manager.listExplorer(active.sessionId, renamedPlans.id);
  assert.equal(nested.entries.find((entry) => entry.name === 'inside.md').resourceId, insideResourceId);
  await manager.duplicateExplorerItem(renamedPlans.id, 'plans-copy', active.sessionId);
  rootListing = await manager.listExplorer(active.sessionId);
  const copiedPlans = rootListing.entries.find((entry) => entry.name === 'plans-copy');
  const copiedNested = await manager.listExplorer(active.sessionId, copiedPlans.id);
  assert.notEqual(copiedNested.entries.find((entry) => entry.name === 'inside.md').resourceId, insideResourceId);
  const folderDelete = await manager.previewExplorerDelete(copiedPlans.id, active.sessionId);
  await manager.cancelExplorerDelete(folderDelete.token, active.sessionId);
  assert.equal((await manager.listExplorer(active.sessionId)).entries.some((entry) => entry.name === 'plans-copy'), true);
});

test('file writes are denied by the project profile and directories keep keyboard-addressable IDs', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  await writeFile(join(root, 'protected.md'), 'keep');
  const host = await fixtureHost(root, 'explorer-permission-test');
  const { manager, active } = await managerFor(t, root, tempRoot, host);
  const initial = await manager.listExplorer(active.sessionId);
  assert.ok(initial.entries.every((entry) => entry.id !== entry.path));
  const protectedEntry = initial.entries.find((entry) => entry.name === 'protected.md');
  const deletePreview = await manager.previewExplorerDelete(protectedEntry.id, active.sessionId);
  assert.equal(deletePreview.deletable, false);
  assert.match(deletePreview.reason, /permiso de eliminación/);
  assert.equal(await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' }), true);
  await assert.rejects(manager.createExplorerItem('project-root', 'blocked.md', 'file', active.sessionId), { code: 'FILE_OPERATION_REJECTED' });
  assert.equal((await manager.listExplorer(active.sessionId)).entries.some((entry) => entry.name === 'blocked.md'), false);
});

test('a mount with a moved local root remains in the explorer as disconnected and read-only', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const external = join(tempRoot, 'external'); await mkdir(join(external, 'references'), { recursive: true });
  await writeFile(join(external, 'references', 'missing.md'), 'mounted');
  const host = await fixtureHost(root, 'explorer-mount-test');
  const mountId = id(990); const resourceId = id(991);
  assert.equal(await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' }), true);
  assert.equal(await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot: external, permission: 'read-only' }), true);
  await writeFile(join(root, '.a3', 'resources', `${resourceId}.json`), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId,
    revision: 1, kind: 'mounted-file', mountId, path: 'references/missing.md', extensions: {} }, null, 2) + '\n');
  const { manager, active } = await managerFor(t, root, tempRoot, host);
  let listing = await manager.listExplorer(active.sessionId);
  assert.equal(listing.mounts.length, 1);
  assert.equal(listing.mounts[0].id, resourceId);
  assert.equal(listing.mounts[0].status, 'available');
  assert.equal(await manager.copyMountedExplorerPath(resourceId, 'absolute', active.sessionId), join(external, 'references', 'missing.md'));
  await rm(join(external, 'references', 'missing.md'));
  listing = await manager.listExplorer(active.sessionId);
  assert.equal(listing.mounts[0].status, 'missing');
  await assert.rejects(manager.openMountedExplorerResource(resourceId, active.sessionId), { code: 'MOUNT_OPEN_FAILED' });
  await rename(external, join(tempRoot, 'external-moved'));
  listing = await manager.listExplorer(active.sessionId);
  assert.equal(listing.mounts[0].status, 'missing');
});

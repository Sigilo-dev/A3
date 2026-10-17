import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const packagePath = fileURLToPath(new URL('../../domain/test/fixtures/declarative-node-package.json', import.meta.url));

test('A3-041/042: create, transactionally save, reopen and validate a declarative node package', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'node-package-roundtrip');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root);
  const sessionId = opened.active.sessionId;
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

  const saved = await manager.saveNodePackage(sessionId, pkg);
  assert.equal(saved.canWrite, true, 'inert project data uses document.edit, while package.install stays unavailable');
  assert.equal(saved.packages.length, 1, JSON.stringify(saved.diagnostics));
  const path = join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`);
  const original = await readFile(path);
  assert.equal(JSON.parse(original.toString('utf8')).collections[0].typeRefs[0].name, pkg.nodeTypes[0].name);
  await assert.rejects(manager.saveNodePackage(sessionId, pkg), { code: 'node-type-version-exists' });
  assert.deepEqual(await readFile(path), original, 'an existing type version cannot be overwritten');

  const invalid = structuredClone(pkg);
  invalid.nodeTypes[0].ports[0].direction = 'inout';
  await assert.rejects(manager.saveNodePackage(sessionId, invalid), { code: 'schema-invalid' });
  assert.deepEqual(await readFile(path), original, 'invalid input cannot replace the saved package');
  assert.equal((await manager.loadNodePackages(sessionId)).packages.length, 1);

  const recentId = opened.recents[0].id;
  await manager.closeActive(sessionId);
  const reopened = await manager.openRecent(recentId);
  const loaded = await manager.loadNodePackages(reopened.active.sessionId);
  assert.equal(loaded.packages[0].manifest.id, pkg.manifest.id);
  assert.equal(loaded.packages[0].nodeTypes[0].ports[0].id, pkg.nodeTypes[0].ports[0].id);
  assert.deepEqual(await readFile(path), original, 'opening the package does not rewrite its JSON bytes');
});

test('A3-041: project-read profile can inspect packages but cannot save a type', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'node-package-read-only', 'consultar');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root);
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const state = await manager.loadNodePackages(opened.active.sessionId);
  assert.equal(state.canWrite, false);
  await assert.rejects(manager.saveNodePackage(opened.active.sessionId, pkg), { code: 'permission-denied' });
  await assert.rejects(readFile(join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`)), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { LocalProjectManager, LocalSearchIndex, searchExcluded, validSearchPatterns } from '../dist/index.js';
import { fixtureHost, scratch } from './fixture.mjs';
const fixture = JSON.parse(await readFile(new URL('../../../fixtures/e4/memory/scenario.json', import.meta.url), 'utf8'));
const windows = { skip: process.platform !== 'win32' };
async function setup(t, existing = false) {
  const { root, tempRoot } = await scratch(t);
  if (existing) { await mkdir(join(root, 'memory'), { recursive: true }); await writeFile(join(root, 'memory/overview.md'), Buffer.from('\ufeff# Memoria previa\r\n\r\n' + fixture.projectA + '\r\n')); }
  const host = await fixtureHost(root, 'memory-person'), manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const sessionId = (await manager.openFolder(root)).active.sessionId; return { root, tempRoot, host, manager, sessionId };
}
test('mandatory exclusions and restricted additional globs omit dependencies, local state, environments, secrets and compiled artifacts', () => {
  for (const path of ['.git/config', '.a3/local/secret.md', 'node_modules/package/index.js', '.venv/lib/a.py', 'venv/a.py', 'src/__pycache__/a.pyc', 'target/main.rs', 'dist/a.js', '.env.local', 'secret.key', 'private/note.md', 'src/view.generated.ts']) assert.equal(searchExcluded(path, fixture.patterns), true, path);
  for (const path of ['memory/overview.md', 'src/main.py', 'docs/readme.md']) assert.equal(searchExcluded(path, fixture.patterns), false, path);
  assert.equal(validSearchPatterns(['../escape']), false); assert.equal(validSearchPatterns(['[arbitrary regex]']), false);
  const index = new LocalSearchIndex(), source = { key: 'a', origin: 'a.md', title: 'Decisión', tags: ['arquitectura'], text: 'Órbita de ejemplo', hash: 'a'.repeat(64), entityIds: [], placements: [] };
  assert.equal(index.update([source]).updated, 1); assert.equal(index.update([source]).unchanged, 1); assert.equal(index.search('orbita').total, 1);
  assert.equal(index.update([]).removed, 1); assert.equal(index.search('orbita').total, 0);
});
test('A3-022: memory initialization adopts original UTF-8 bytes and IDs remain stable after editing, moving and reopen; summary has explicit source/date', windows, async (t) => {
  const c = await setup(t, true), original = await readFile(join(c.root, 'memory/overview.md'));
  const first = await c.manager.initializeMemory(c.sessionId); assert.equal(first.documents.length, 3); assert.equal(first.missingRoles.length, 0);
  assert.deepEqual(await readFile(join(c.root, 'memory/overview.md')), original);
  const second = await c.manager.initializeMemory(c.sessionId); assert.deepEqual(second.documents, first.documents);
  const overview = first.documents.find((doc) => doc.role === 'overview');
  const opened = await c.manager.openMarkdownDocument(c.sessionId, overview.entityId, overview.resourceId);
  const saved = await c.manager.saveMarkdownDocument({ sessionId: c.sessionId, entityId: overview.entityId, resourceId: overview.resourceId, entityRevision: opened.entityRevision, expectedRevision: opened.revision, expectedHash: opened.hash, content: opened.content + 'Edición explícita\r\n' });
  assert.match(saved.content, /Edición explícita/);
  const summarized = await c.manager.createMemorySummary(c.sessionId, { title: 'Síntesis revisada', content: fixture.summary, sourceIds: [overview.resourceId] });
  const summary = summarized.documents.find((doc) => doc.role === 'summary'); assert.ok(summary.summary.recordedAt); assert.equal(summary.summary.sources[0].hash, saved.hash);
  assert.deepEqual(summary.summary.actor, c.host.authenticatedActor); assert.deepEqual(await readFile(join(c.root, summary.path), 'utf8'), fixture.summary);
  // Move through the accepted page command so the resource ID, not its original path, remains authoritative.
  const canvas = await c.manager.navigationIndex(c.sessionId); const page = canvas.pages.find((p) => p.entityId === overview.entityId);
  await c.manager.movePage(c.sessionId, overview.entityId, page.revision, 'memory/renamed-overview.md');
  const moved = (await c.manager.loadMemory(c.sessionId)).documents.find((doc) => doc.role === 'overview'); assert.equal(moved.resourceId, overview.resourceId); assert.equal(moved.path, 'memory/renamed-overview.md');
  assert.equal((await c.manager.initializeMemory(c.sessionId)).documents.filter((doc) => doc.role === 'overview').length, 1);
  await c.manager.closeActive(c.sessionId); const next = (await c.manager.openFolder(c.root)).active.sessionId;
  assert.equal((await c.manager.loadMemory(next)).documents.find((doc) => doc.role === 'overview').entityId, overview.entityId);
});
test('A3-023: text/title/tags/code search updates incrementally and rebuild preserves results/exclusions; binary and links stay excluded', windows, async (t) => {
  const c = await setup(t); await c.manager.initializeMemory(c.sessionId);
  await mkdir(join(c.root, 'src'), { recursive: true }); await writeFile(join(c.root, 'src/main.ts'), fixture.code);
  await writeFile(join(c.root, 'src/note.txt'), fixture.before);
  for (const folder of ['private', '.venv', 'node_modules', 'dist']) { await mkdir(join(c.root, folder), { recursive: true }); await writeFile(join(c.root, folder, 'hidden.txt'), fixture.excluded); }
  await writeFile(join(c.root, 'src/binary.txt'), Buffer.concat([Buffer.from([0, 1, 2, 3, 65]), Buffer.from(fixture.excluded)])); await writeFile(join(c.root, 'src/view.generated.ts'), fixture.excluded);
  const outside = join(c.tempRoot, 'outside'); await mkdir(outside); await writeFile(join(outside, 'outside.txt'), fixture.excluded); await symlink(outside, join(c.root, 'link'), 'junction');
  let found = await c.manager.searchProject(c.sessionId, 'codigoseguro', false, fixture.patterns); assert.equal(found.total, 1); assert.equal(found.results[0].origin, 'src/main.ts');
  assert.ok((await c.manager.searchProject(c.sessionId, 'vision')).results.some((hit) => hit.origin === 'memory/overview.md')); assert.ok((await c.manager.searchProject(c.sessionId, 'memory')).results.some((hit) => hit.tags.includes('memory')));
  assert.equal((await c.manager.searchProject(c.sessionId, 'termitasecreta')).total, 0);
  found = await c.manager.searchProject(c.sessionId, 'integridadlunar'); assert.equal(found.total, 1);
  const opened = await c.manager.openCodeDocument(c.sessionId, { itemId: found.results[0].itemId });
  await c.manager.saveCodeDocument({ sessionId: c.sessionId, documentId: opened.documentId, expectedRevision: opened.revision, expectedHash: opened.hash, content: fixture.after });
  assert.equal((await c.manager.searchProject(c.sessionId, 'integridadlunar')).total, 0);
  found = await c.manager.searchProject(c.sessionId, 'orbitasolar'); const rebuilt = await c.manager.searchProject(c.sessionId, 'orbitasolar', true);
  assert.deepEqual(rebuilt.results, found.results); assert.deepEqual(rebuilt.exclusions, fixture.patterns);
  assert.equal((await c.manager.searchProject(c.sessionId, 'orbitasolar')).stats.updated, 0);
  await rename(join(c.root, 'src/note.txt'), join(c.root, 'src/moved.txt')); assert.equal((await c.manager.searchProject(c.sessionId, 'orbitasolar')).results[0].origin, 'src/moved.txt');
});
test('A3-022: switching between distinct projects cannot inherit cached text, summaries or old session IDs', windows, async (t) => {
  const c = await setup(t), other = join(c.tempRoot, 'project-b'); await cp(c.root, other, { recursive: true });
  const manifest = JSON.parse(await readFile(join(other, 'a3.project.json'), 'utf8')); manifest.projectId = '00000000-0000-4000-8000-000000000099'; await writeFile(join(other, 'a3.project.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(c.root, 'local.txt'), fixture.projectA); await writeFile(join(other, 'local.txt'), fixture.projectB);
  assert.equal((await c.manager.searchProject(c.sessionId, 'alpaca')).total, 1);
  const next = (await c.manager.openFolder(other)).active.sessionId;
  assert.equal((await c.manager.searchProject(next, 'alpaca')).total, 0); assert.equal((await c.manager.searchProject(next, 'pelicano', true)).total, 1);
  assert.equal((await c.manager.loadMemory(next)).documents.length, 0);
  await assert.rejects(c.manager.searchProject(c.sessionId, 'alpaca'), { code: 'STALE_SESSION' });
});
test('read-only policy cannot initialize/edit memory and revoking project.read blocks cached search', windows, async (t) => {
  const c = await setup(t); await c.manager.initializeMemory(c.sessionId); await c.manager.searchProject(c.sessionId, 'vision');
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'document.edit', mode: 'deny' });
  assert.equal((await c.manager.loadMemory(c.sessionId)).canWrite, false); await assert.rejects(c.manager.initializeMemory(c.sessionId), { code: 'PERMISSION_DENIED' });
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'project.read', mode: 'deny' });
  await assert.rejects(c.manager.searchProject(c.sessionId, 'vision'), { code: 'PERMISSION_DENIED' });
});

test('mounted code requires both index and read grants and a live approved root; revocation removes previous hits', windows, async (t) => {
  const c = await setup(t), external = join(c.tempRoot, 'mounted'), mountId = '80000000-0000-4000-8000-000000000100', resourceId = '80000000-0000-4000-8000-000000000101';
  await mkdir(external); await writeFile(join(external, 'main.py'), 'print("mountonlytoken")\n');
  await c.manager.closeActive(c.sessionId);
  await writeFile(join(c.root, '.a3/resources', resourceId + '.json'), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId, revision: 1, kind: 'mounted-file', mountId, path: 'main.py', mediaType: 'text/x-python', extensions: {} }));
  assert.equal(await c.host.capabilities.approveLocalMount({ root: c.root, projectId: c.host.projectId, mountId, selectedRoot: external, permission: 'read-only' }), true);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'mount.read', mode: 'direct' });
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'mount.index', mode: 'deny' });
  const sessionId = (await c.manager.openFolder(c.root)).active.sessionId;
  assert.equal((await c.manager.searchProject(sessionId, 'mountonlytoken')).total, 0);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'mount.index', mode: 'direct' });
  const allowed = await c.manager.searchProject(sessionId, 'mountonlytoken'); assert.equal(allowed.total, 1); assert.equal(allowed.results[0].resourceId, resourceId); assert.match(allowed.results[0].origin, /^@mount\//);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'mount.read', mode: 'deny' });
  assert.equal((await c.manager.searchProject(sessionId, 'mountonlytoken')).total, 0);
  await c.host.capabilities.setGrant({ root: c.root, projectId: c.host.projectId, capability: 'mount.read', mode: 'direct' });
  await rename(external, join(c.tempRoot, 'relocated'));
  const absent = await c.manager.searchProject(sessionId, 'mountonlytoken'); assert.equal(absent.total, 0); assert.equal(absent.partial, true);
});

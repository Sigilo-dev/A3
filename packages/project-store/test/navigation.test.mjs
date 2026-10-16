import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNavigationIndex, resolvePageLink, rewritePageReferences, LocalProjectManager, openProjectService } from '../dist/index.js';
import { E1, id, scratch, fixtureHost } from './fixture.mjs';
import { defaultShortcuts } from '../../domain/dist/src/shortcuts.js';
import { revisionsOf } from '@a3/domain';
const source = (n, title, path, content) => ({ entityId: id(n), resourceId: id(n + 100), revision: 1, resourceRevision: 1, title, path, content });

test('A3-010: resolves identity, readable aliases, heading slugs and both E0/stable block forms; ambiguous names never guess', () => {
  const pages = [source(1, 'Inicio', 'pages/start.md', '[[Guía|Alias]] [[Guía#Mi sección]] [[Guía^stable]] [[Guía#^stable]]\n[Normal](guide.md#mi-sección)\n`[[No]]`\n```md\n[[No]]\n```'),
    source(2, 'Guía', 'pages/guide.md', '# Mi sección\r\n\r\nPárrafo ^stable\r\n')];
  const index = buildNavigationIndex(pages);
  assert.equal(index.links.length, 5); assert.ok(index.links.every((l) => l.status === 'resolved' && l.entityId === id(2)));
  assert.equal(index.links[0].label, 'Alias'); assert.equal(index.links[2].anchor.kind, 'block');
  assert.equal(index.links[1].anchor.offset, 0); assert.equal(index.links[4].anchor.offset, 0);
  assert.equal(resolvePageLink(index, id(1), id(2)).entityId, id(2));
  const ambiguous = buildNavigationIndex([...pages, source(3, 'Guía', 'other/guide.md', '# Otra\n')]);
  assert.deepEqual(resolvePageLink(ambiguous, id(1), 'Guía').candidates, [id(2), id(3)]);
  assert.equal(resolvePageLink(ambiguous, id(1), 'Guía').status, 'ambiguous');
  assert.equal(resolvePageLink(index, id(1), 'javascript:alert(1)', 'markdown').status, 'external');
  assert.equal(resolvePageLink(index, id(1), '../../outside.md', 'markdown').status, 'missing');
  assert.equal(resolvePageLink(index, id(1), 'Guía#ausente').status, 'missing');
});

test('known reference edits preserve CRLF, aliases, inline titles, code and untouched unknown syntax; relative links follow source and target moves', () => {
  const original = '---\r\nunknown: yes\r\n---\r\n[[Guía|Leíble]] [[Guía^b|Bloque]]\r\n[ir](guide.md#intro "Título") [ángulo](<guide.md>)\r\n`[[Guía]]`\r\n';
  const pages = [source(1, 'Inicio', 'pages/start.md', original), source(2, 'Guía', 'pages/guide.md', '# Intro\r\ntexto ^b\r\n')];
  const changed = pages.map((p) => p.entityId === id(2) ? { ...p, title: 'Manual', path: 'docs/manual.md' } : p);
  const result = rewritePageReferences(pages, changed).get(id(101));
  assert.equal(result, original.replace('[[Guía|', '[[Manual|').replace('[[Guía^b|', '[[Manual^b|').replaceAll('guide.md', '../docs/manual.md'));
  const movedSource = changed.map((p) => p.entityId === id(1) ? { ...p, path: 'start.md' } : p);
  assert.match(rewritePageReferences(pages, movedSource).get(id(101)), /\]\(docs\/manual.md#intro/);
});
test('standard reference destinations are indexed per use and edited once; images, code, comments and frontmatter are not page links', () => {
  const text = '---\ncustom: "[[Guía]]"\n---\n[Alias][guide] [guide][] [guide]\n\n[guide]: guide.md#intro "Title"\n![image][guide]\n<!--\n[[Guía]]\n-->\n~~~md\n[[Guía]]\n~~~\n';
  const pages = [source(1, 'Inicio', 'pages/start.md', text), source(2, 'Guía', 'pages/guide.md', '# Intro\n')];
  assert.equal(buildNavigationIndex(pages).links.length, 3);
  const result = rewritePageReferences(pages, pages.map((p) => p.entityId === id(2) ? { ...p, path: 'docs/guide.md' } : p));
  assert.equal(result.get(id(101)), text.replace('guide.md#intro', '../docs/guide.md#intro'));
});
test('destination span never rewrites an identical label; percent-escaped filename delimiters stay filenames', () => {
  const pages = [source(1, 'Inicio', 'pages/start.md', '[guide.md](guide.md) [hash](a%23b.md#intro)'), source(2, 'Guía', 'pages/guide.md', '# Intro\n'), source(3, 'Hash', 'pages/a#b.md', '# Intro\n')];
  assert.ok(buildNavigationIndex(pages).links.every((l) => l.status === 'resolved'));
  assert.equal(resolvePageLink(buildNavigationIndex(pages), id(1), '/pages/guide.md', 'markdown').status, 'missing');
  const next = pages.map((p) => p.entityId === id(2) ? { ...p, path: 'docs/guide.md' } : p);
  assert.equal(rewritePageReferences(pages, next).get(id(101)), '[guide.md](../docs/guide.md) [hash](a%23b.md#intro)');
});

async function setup(t, profile = 'trabajar') {
  const { root, tempRoot } = await scratch(t);
  const entity = JSON.parse(await readFile(join(root, '.a3/entities', E1 + '.json'), 'utf8'));
  const resource = JSON.parse(await readFile(join(root, '.a3/resources', entity.contentResourceId + '.json'), 'utf8'));
  entity.title = 'Guía'; await writeFile(join(root, '.a3/entities', E1 + '.json'), JSON.stringify(entity));
  await writeFile(join(root, resource.path), '# Intro\r\n\r\nPárrafo ^block\r\n');
  const second = { ...entity, id: id(22), title: 'Origen', contentResourceId: id(23) }, secondResource = { ...resource, id: id(23), path: 'pages/source.md' };
  await writeFile(join(root, '.a3/entities', second.id + '.json'), JSON.stringify(second));
  await writeFile(join(root, '.a3/resources', secondResource.id + '.json'), JSON.stringify(secondResource));
  const bytes = Buffer.from('\ufeff# Origen\r\n\r\n[[Guía|Alias]] [[Guía#Intro]] [[Guía^block]]\r\n[normal](readme.md#intro "Keep")\r\n`[[Guía]]`\r\n');
  await writeFile(join(root, secondResource.path), bytes);
  const host = await fixtureHost(root, 'navigation', profile), options = { stateDirectory: join(tempRoot, 'catalog'), host };
  const manager = new LocalProjectManager(options); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  return { manager, active, root, options, host, bytes, entity, second, resource, secondResource };
}
const windows = { skip: process.platform !== 'win32' };
test('A3-010/047: transactional rename and move update known references; IDs/extensions survive, stale plans fail, index regenerates after restart', windows, async (t) => {
  const f = await setup(t); const { manager, active, root, entity, second } = f;
  let index = await manager.navigationIndex(active.sessionId); assert.equal(index.links.filter((l) => l.entityId === E1).length, 4);
  await manager.renamePage(active.sessionId, E1, entity.revision, 'Manual');
  const text = await readFile(join(root, f.secondResource.path), 'utf8');
  assert.ok(text.startsWith('\ufeff')); assert.match(text, /\[\[Manual\|Alias\]\]/); assert.match(text, /\[\[Manual\^block\|Guía\^block\]\]/); assert.match(text, /`\[\[Guía\]\]`/);
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
  await assert.rejects(manager.renamePage(active.sessionId, E1, entity.revision, 'Stale'), { code: 'REVISION_CONFLICT' });
  await mkdir(join(root, 'docs')); // Newly created ordinary directory: no portable metadata changes.
  await manager.movePage(active.sessionId, E1, entity.revision + 1, 'docs/manual.md');
  assert.match(await readFile(join(root, f.secondResource.path), 'utf8'), /\]\(\.\.\/docs\/manual.md#intro "Keep"\)/);
  await assert.rejects(readFile(join(root, f.resource.path)), { code: 'ENOENT' });
  const after = JSON.parse(await readFile(join(root, '.a3/entities', E1 + '.json'), 'utf8')); assert.deepEqual(after.extensions, entity.extensions);
  const resource = JSON.parse(await readFile(join(root, '.a3/resources', f.resource.id + '.json'), 'utf8')); assert.equal(resource.id, f.resource.id); assert.equal(resource.path, 'docs/manual.md');
  index = await manager.navigationIndex(active.sessionId); assert.ok(index.links.filter((l) => l.sourceId === second.id).every((l) => l.status === 'resolved'));
  await manager.shutdown(); const again = new LocalProjectManager(f.options); t.after(() => again.dispose());
  const resumed = (await again.restoreLastProject()).active, rebuilt = await again.navigationIndex(resumed.sessionId);
  assert.deepEqual(rebuilt, index); assert.equal(rebuilt.links.filter((l) => l.entityId === E1).length, 4);
  const local = await readdir(join(root, '.a3/local/transactions')); assert.ok(local.length >= 2, 'uses existing journal rather than separate ad hoc file writes');
});

test('broker denies page rename/move and index cannot bypass a revoked read grant', windows, async (t) => {
  const f = await setup(t, 'consultar'), { manager, active, host, root } = f;
  assert.equal((await manager.menuPermissions(active.sessionId)).document.allowed, false);
  await assert.rejects(manager.renamePage(active.sessionId, E1, 1, 'Forbidden'), { code: 'PERMISSION_DENIED' });
  await assert.rejects(manager.movePage(active.sessionId, E1, 1, 'pages/moved.md'), /rechaz|deneg|broker/i);
  assert.deepEqual(await readFile(join(root, f.secondResource.path)), f.bytes);
  await host.capabilities.revoke({ root, projectId: host.projectId, capability: 'project.read' });
  await assert.rejects(manager.navigationIndex(active.sessionId), /lectura|broker|permiso/i);
});

test('external edit after a rename plan rejects the whole transaction without overwriting either page', windows, async (t) => {
  const f = await setup(t); await f.manager.shutdown();
  const opened = await openProjectService(f.root, { host: f.host }); assert.ok(opened.ok); const lease = opened.value; t.after(() => lease.close());
  const plan = await lease.service.preparePageRename({ operationId: id(99), entityId: E1, expectedRevision: 1, title: 'New' }); assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  await writeFile(join(f.root, f.secondResource.path), 'External newer bytes\r\n');
  const committed = await lease.service.commit(plan.value); assert.equal(committed.ok, false);
  assert.equal(await readFile(join(f.root, f.secondResource.path), 'utf8'), 'External newer bytes\r\n');
  assert.equal(JSON.parse(await readFile(join(f.root, '.a3/entities', E1 + '.json'), 'utf8')).title, 'Guía');
});

test('local shortcut persistence rejects collisions, restores defaults and never writes portable project data', windows, async (t) => {
  const f = await setup(t), defaults = await f.manager.shortcuts(); assert.deepEqual(defaults, defaultShortcuts());
  const custom = { ...defaults, back: 'Alt+J', duplicate: 'Ctrl+Alt+D' };
  await f.manager.shortcuts(custom);
  await assert.rejects(f.manager.shortcuts({ ...custom, forward: 'Alt+J' }), { code: 'SHORTCUT_COLLISION' });
  assert.deepEqual(await f.manager.shortcuts(), custom);
  await f.manager.shutdown(); const manager = new LocalProjectManager(f.options); t.after(() => manager.dispose());
  assert.deepEqual(await manager.shortcuts(), custom); assert.deepEqual(await manager.shortcuts('reset'), defaults);
  await assert.rejects(readFile(join(f.root, 'shortcuts.json')), { code: 'ENOENT' });
});

test('localized missing Markdown reports diagnostics and leaves valid outgoing links available', windows, async (t) => {
  const f = await setup(t); await f.manager.shutdown();
  const { unlink } = await import('node:fs/promises'); await unlink(join(f.root, f.resource.path));
  const manager = new LocalProjectManager(f.options); t.after(() => manager.dispose());
  const active = (await manager.openFolder(f.root)).active, index = await manager.navigationIndex(active.sessionId);
  assert.ok(index.pages.some((p) => p.entityId === f.second.id)); assert.ok(index.diagnostics.length); assert.equal(index.links[0].status, 'missing');
  await assert.rejects(readFile(join(f.root, f.resource.path)), { code: 'ENOENT' });
});

test('generic domain title and resource-move commands also append reference updates to their journal plan', windows, async (t) => {
  const f = await setup(t); await f.manager.shutdown(); const opened = await openProjectService(f.root, { host: f.host }); assert.ok(opened.ok); const { service } = opened.value; t.after(() => opened.value.close());
  const command = (name, payload, n, hashes = []) => ({ operationId: id(n), actor: f.host.authenticatedActor, projectId: f.active.projectId, command: name, payload,
    scope: { entityIds: [E1] }, expectedRevisions: revisionsOf(service.state.project.snapshot), expectedContentHashes: hashes });
  let plan = await service.prepare(command('a3.core.update-entity', { title: 'Generic' }, 110)); assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  assert.ok(plan.value.changes.some((c) => c.path === f.secondResource.path)); assert.ok((await service.commit(plan.value)).ok);
  assert.match(await readFile(join(f.root, f.secondResource.path), 'utf8'), /\[\[Generic\|Alias\]\]/);
  const source = await service.openResource(f.resource.id); assert.ok(source.ok);
  plan = await service.prepare(command('a3.core.move-resource', { resourceId: f.resource.id, location: { kind: 'project-file', path: 'generic.md' } }, 111, [{ resourceId: f.resource.id, hash: source.value.sha256 }])); assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
  assert.ok((await service.commit(plan.value)).ok); assert.match(await readFile(join(f.root, f.secondResource.path), 'utf8'), /\]\(\.\.\/generic.md#intro/);
});

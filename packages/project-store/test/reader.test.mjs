import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readProject, readProjectResource, resolvePortablePath } from '../dist/reader.js';
import { encodeDocument, sha256 } from '../dist/index.js';
import { E1, W1, P1, entityPath, id, scratch } from './fixture.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const descriptor = (project) => project.snapshot.records.find((r) => r.kind === 'resource').value;
test('E0 project opens: separated documents, shared entity, every file exact round-trip', async (t) => {
  const { root } = await scratch(t);
  const project = await readProject(root);
  assert.equal(project.mode, 'ready', JSON.stringify(project.diagnostics));
  assert.equal(project.catalogComplete, true);
  assert.equal(project.writable, false);
  assert.equal(project.snapshot.records.length, 12);
  assert.equal(project.snapshot.records.filter((r) => r.kind === 'placement' && r.value.entityId === E1).length, 2);
  assert.ok(project.snapshot.records.some((r) => r.kind === 'visual-edge'));
  assert.ok(project.snapshot.records.some((r) => r.kind === 'relation-view'));
  for (const doc of project.documents) {
    assert.equal(doc.status, 'valid');
    assert.deepEqual(Buffer.from(encodeDocument(doc).bytes), await readFile(join(root, doc.location.path)));
  }
});
test('corruption is localized; healthy files open and original bytes stay untouched', async (t) => {
  const { root } = await scratch(t);
  const source = Buffer.from('{\n  "title": "á",\n  "revision":');
  await writeFile(join(root, entityPath), source);
  const manifestBefore = await readFile(join(root, 'a3.project.json'));
  const markdownBefore = await readFile(join(root, 'pages/readme.md'));
  const project = await readProject(root);
  assert.equal(project.mode, 'degraded');
  const broken = project.documents.find((d) => d.location.path === entityPath);
  assert.equal(broken.status, 'invalid');
  assert.equal(broken.record, undefined);
  assert.deepEqual(Buffer.from(broken.originalBytes()), source);
  const diagnostic = project.diagnostics.find((d) => d.detail === 'invalid-json');
  assert.equal(diagnostic.path, entityPath);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.byteOffset, source.length);
  assert.ok(project.diagnostics.some((d) => d.stage === 'references' && d.detail === 'entity-missing'));
  assert.equal(project.snapshot.records.length, 11);
  assert.deepEqual(await readFile(join(root, entityPath)), source);
  assert.deepEqual(await readFile(join(root, 'a3.project.json')), manifestBefore);
  assert.deepEqual(await readFile(join(root, 'pages/readme.md')), markdownBefore);
});
test('manifest major unknown is safe inspection without guessing a new catalog layout', async (t) => {
  const { root } = await scratch(t);
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json')));
  manifest.formatVersion = '2.0.0';
  manifest.catalogRoot = '../outside';
  const source = Buffer.from(json(manifest));
  await writeFile(join(root, 'a3.project.json'), source);
  const project = await readProject(root);
  assert.equal(project.mode, 'read-only');
  assert.equal(project.writable, false);
  assert.equal(project.catalogComplete, false);
  assert.equal(project.documents.length, 1);
  assert.equal(project.snapshot.records.length, 0);
  assert.equal(project.documents[0].value.formatVersion, '2.0.0');
  assert.deepEqual(Buffer.from(project.documents[0].originalBytes()), source);
  assert.equal(encodeDocument(project.documents[0]).ok, false);
});
test('unknown entity schema preserves the file and permits reading healthy neighbors', async (t) => {
  const { root } = await scratch(t);
  const value = JSON.parse(await readFile(join(root, entityPath)));
  value.schemaVersion = '2.0.0';
  value.extra = { future: ['still here'] };
  const source = Buffer.from(json(value));
  await writeFile(join(root, entityPath), source);
  const project = await readProject(root);
  assert.equal(project.mode, 'read-only');
  assert.equal(project.snapshot.records.length, 11);
  const doc = project.documents.find((d) => d.location.path === entityPath);
  assert.deepEqual(doc.value.extra, value.extra);
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
  assert.equal(encodeDocument(doc).ok, false);
});
test('schema and references are separate; a dangling resource reference is never deleted', async (t) => {
  const { root } = await scratch(t);
  const value = JSON.parse(await readFile(join(root, entityPath)));
  value.contentResourceId = id(123);
  await writeFile(join(root, entityPath), json(value));
  const source = await readFile(join(root, entityPath));
  const project = await readProject(root);
  const doc = project.documents.find((d) => d.location.path === entityPath);
  assert.equal(doc.status, 'valid');
  assert.deepEqual(doc.diagnostics, []);
  const issue = project.diagnostics.find((d) => d.detail === 'resource-missing');
  assert.equal(issue.stage, 'references');
  assert.equal(issue.path, entityPath);
  assert.deepEqual(await readFile(join(root, entityPath)), source);
});
test('relative catalog root and source path work, without changing portability', async (t) => {
  const { root } = await scratch(t);
  await rename(join(root, '.a3'), join(root, 'catalog'));
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json')));
  manifest.catalogRoot = 'catalog';
  await writeFile(join(root, 'a3.project.json'), json(manifest));
  const project = await readProject(root);
  assert.equal(project.mode, 'ready', JSON.stringify(project.diagnostics));
  const source = await readProjectResource(root, descriptor(project));
  assert.equal(source.ok, true);
  assert.equal(source.value.path, 'pages/readme.md');
  assert.deepEqual(Buffer.from(source.value.bytes), await readFile(join(root, 'pages/readme.md')));
  assert.equal(resolvePortablePath(root, 'pages/readme.md'), join(root, 'pages', 'readme.md'));
  for (const path of ['../secret', '/absolute', 'C:/file', 'pages\\file', 'pages//file', './file', 'a/../b', 'CON.txt', 'a/b.', 'a/b ', 'a/fi?le']) assert.throws(() => resolvePortablePath(root, path));
});
test('Markdown and code resources preserve BOM, UTF-16, CRLF and arbitrary bytes', async (t) => {
  const { root } = await scratch(t);
  const project = await readProject(root);
  const resource = descriptor(project);
  const sources = [Buffer.from('\uFEFF# Heading\r\n\r\n[[wikilink]]\r\n'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('print("á")\r\n', 'utf16le')]), Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80])];
  for (const source of sources) {
    await writeFile(join(root, resource.path), source);
    const opened = await readProjectResource(root, resource);
    assert.equal(opened.ok, true);
    assert.deepEqual(Buffer.from(opened.value.bytes), source);
    assert.equal(opened.value.sha256, sha256(source));
    assert.equal((await readProject(root)).mode, 'ready');
    assert.deepEqual(await readFile(join(root, resource.path)), source);
  }
});
test('mounted and remote descriptors are not followed by the local reader', async (t) => {
  const { root } = await scratch(t);
  const resource = descriptor(await readProject(root));
  const { path: _path, ...base } = resource;
  for (const external of [{ ...base, kind: 'remote-url', url: 'https://example.invalid/file' }, { ...base, kind: 'mounted-file', mountId: id(111), path: 'file.md' }]) {
    const result = await readProjectResource(root, external);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'PERMISSION_DENIED');
  }
});
test('filename/header mismatch is diagnosed and excluded from typed records', async (t) => {
  const { root } = await scratch(t);
  const value = JSON.parse(await readFile(join(root, entityPath)));
  value.id = id(555);
  await writeFile(join(root, entityPath), json(value));
  const project = await readProject(root);
  const doc = project.documents.find((d) => d.location.path === entityPath);
  assert.equal(doc.status, 'invalid');
  assert.equal(doc.writable, false);
  assert.equal(project.snapshot.records.length, 11);
  assert.ok(project.diagnostics.some((d) => d.detail === 'file-identity-mismatch'));
});
test('E1-B collections, groups and variable sets use the ratified scopes', async (t) => {
  const { root } = await scratch(t);
  for (const path of ['.a3/collections', `.a3/workspaces/${W1}/groups`, '.a3/variables/workspaces', '.a3/variables/entities']) await mkdir(join(root, path), { recursive: true });
  const header = { schemaVersion: '1.0.0', revision: 1, extensions: {} };
  const manifest = JSON.parse(await readFile(join(root, 'a3.project.json')));
  const files = [
    [`.a3/collections/${id(20)}.json`, { ...header, id: id(20), name: 'References', entityIds: [E1] }],
    [`.a3/workspaces/${W1}/groups/${id(21)}.json`, { ...header, id: id(21), name: 'Group', members: [{ kind: 'placement', id: P1 }] }],
    ['.a3/variables/project.json', { ...header, scope: { kind: 'project', ownerId: manifest.projectId }, variables: [] }],
    [`.a3/variables/workspaces/${W1}.json`, { ...header, scope: { kind: 'workspace', ownerId: W1 }, variables: [] }],
    [`.a3/variables/entities/${E1}.json`, { ...header, scope: { kind: 'entity', ownerId: E1 }, variables: [] }]
  ];
  for (const [path, value] of files) await writeFile(join(root, path), json(value));
  const project = await readProject(root);
  assert.equal(project.mode, 'ready', JSON.stringify(project.diagnostics));
  assert.equal(project.snapshot.records.length, 17);
  for (const doc of project.documents) assert.deepEqual(Buffer.from(encodeDocument(doc).bytes), await readFile(join(root, doc.location.path)));
});
test('junction or symlink catalogs and sources are rejected without reading outside data', async (t) => {
  const { root, tempRoot } = await scratch(t);
  const external = join(tempRoot, 'external');
  await mkdir(external);
  const marker = Buffer.from('outside bytes');
  await writeFile(join(external, 'secret.md'), marker);
  await symlink(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const resource = { ...descriptor(await readProject(root)), path: 'linked/secret.md' };
  const result = await readProjectResource(root, resource);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].detail, 'linked-path');
  await rename(join(root, '.a3/entities'), join(root, 'entities-backup'));
  await symlink(external, join(root, '.a3/entities'), process.platform === 'win32' ? 'junction' : 'dir');
  const project = await readProject(root);
  assert.equal(project.mode, 'degraded');
  assert.equal(project.catalogComplete, false);
  assert.ok(project.diagnostics.some((d) => d.path === '.a3/entities' && d.detail === 'linked-path'));
  assert.ok(!project.documents.some((d) => d.location.path.includes('secret')));
  assert.deepEqual(await readFile(join(external, 'secret.md')), marker);
});
test('budgets report partial catalog rather than pretending an empty project is valid', async (t) => {
  const { root } = await scratch(t);
  const source = await readFile(join(root, 'a3.project.json'));
  const small = await readProject(root, { maxDocumentBytes: 10 });
  assert.equal(small.mode, 'unavailable');
  assert.equal(small.catalogComplete, false);
  assert.ok(small.diagnostics.some((d) => d.detail === 'read-limit'));
  const partial = await readProject(root, { maxDocuments: 2 });
  assert.equal(partial.mode, 'degraded');
  assert.equal(partial.catalogComplete, false);
  assert.equal(partial.documents.length, 2);
  assert.deepEqual(await readFile(join(root, 'a3.project.json')), source);
});
test('missing manifest or source produces explicit diagnostics with no replacement', async (t) => {
  const { root } = await scratch(t);
  await rename(join(root, 'pages/readme.md'), join(root, 'pages/kept.md'));
  const project = await readProject(root);
  assert.equal(project.mode, 'degraded');
  assert.ok(project.diagnostics.some((d) => d.stage === 'references' && d.code === 'RESOURCE_MISSING' && d.pointer === '/path'));
  await rename(join(root, 'a3.project.json'), join(root, 'kept-manifest.json'));
  const unavailable = await readProject(root);
  assert.equal(unavailable.mode, 'unavailable');
  assert.equal(unavailable.snapshot.records.length, 0);
  assert.equal(unavailable.documents.length, 0);
});
test('non portable resource descriptor is a schema error before native path resolution', async (t) => {
  const { root } = await scratch(t);
  const initial = await readProject(root);
  const resource = descriptor(initial);
  const path = `.a3/resources/${resource.id}.json`;
  await writeFile(join(root, path), json({ ...resource, path: '../outside.md' }));
  const project = await readProject(root);
  assert.equal(project.mode, 'degraded');
  const doc = project.documents.find((d) => d.location.path === path);
  assert.equal(doc.status, 'invalid');
  assert.ok(doc.diagnostics.some((d) => d.stage === 'schema' && d.pointer === '/path'));
  assert.ok(!project.diagnostics.some((d) => d.stage === 'io' && d.path.includes('outside')));
});
test('opaque drawings preserve bytes for inspection and are never rewritten', async (t) => {
  const { root } = await scratch(t);
  const folder = `.a3/workspaces/${W1}/drawings`;
  await mkdir(join(root, folder));
  const source = Buffer.from(json({ schemaVersion: '1.0.0', id: id(90), revision: 1, extensions: {}, geometry: { unknown: 'retained' } }));
  await writeFile(join(root, folder, `${id(90)}.json`), source);
  const project = await readProject(root);
  assert.equal(project.mode, 'read-only');
  const doc = project.documents.find((d) => d.location.kind === 'drawing');
  assert.deepEqual(Buffer.from(doc.originalBytes()), source);
  assert.equal(encodeDocument(doc).ok, false);
});

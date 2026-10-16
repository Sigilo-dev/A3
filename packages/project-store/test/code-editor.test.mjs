import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager, decodeCodeText, encodeCodeText } from '../dist/index.js';
import { fixtureHost, id, scratch, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const save = (manager, sessionId, document, content) => manager.saveCodeDocument({ sessionId, documentId: document.documentId,
  expectedRevision: document.revision, expectedHash: document.hash, content });
async function setup(t, files = {}) {
  const { root, tempRoot } = await scratch(t);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  const host = await fixtureHost(root, 'code-editor-test');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  const open = async (name) => {
    const entry = (await manager.listExplorer(active.sessionId)).entries.find((e) => e.name === name);
    assert.ok(entry, name); return manager.openCodeDocument(active.sessionId, { itemId: entry.id });
  };
  return { root, tempRoot, host, manager, active, open };
}

test('A3-011: strict Unicode codecs reproduce BOMs, UTF-8/16 and LF/CRLF byte for byte', () => {
  for (const encoding of ['utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom']) {
    for (const separator of ['\n', '\r\n']) {
      const source = `const saludo = "niño · 日本語 · 😀";${separator}saludo;${separator}`;
      const bytes = encodeCodeText(source, encoding), decoded = decodeCodeText(bytes);
      assert.equal(decoded.state, 'text'); assert.equal(decoded.content, source); assert.equal(decoded.encoding, encoding);
      assert.equal(decoded.lineEnding, separator === '\n' ? 'lf' : 'crlf'); assert.equal(decoded.readOnlyReason, null);
      assert.deepEqual(encodeCodeText(decoded.content, decoded.encoding), bytes);
    }
  }
  assert.equal(decodeCodeText(Buffer.alloc(0)).content, '');
  assert.throws(() => encodeCodeText('\ud800', 'utf-8'), /Unicode/);
});

test('binary, invalid encoding and mixed separators never become writable text', () => {
  for (const bytes of [Buffer.from([0, 65, 66]), Buffer.from('%PDF-1.7\nASCII payload'), Buffer.from('GIF89a'), Buffer.from('PK\x03\x04test')]) {
    assert.equal(decodeCodeText(bytes).state, 'binary'); assert.equal(decodeCodeText(bytes).content, null);
  }
  for (const bytes of [Buffer.from([0xe9]), Buffer.from([0xff, 0xfe, 0, 0xd8]), Buffer.from([0xfe, 0xff, 0])]) {
    assert.equal(decodeCodeText(bytes).state, 'unsupported-encoding'); assert.equal(decodeCodeText(bytes).content, null);
  }
  for (const source of ['one\r\ntwo\n', 'one\rtwo']) {
    const decoded = decodeCodeText(Buffer.from(source)); assert.equal(decoded.content, source); assert.ok(decoded.readOnlyReason);
  }
});

test('opening/no-op never registers or normalizes; first edit journals bytes and resource together, then preserves ID on rename', windows, async (t) => {
  const source = '\ufeffconst café = "😀";\r\n';
  const { root, manager, active, open } = await setup(t, { 'source.ts': source });
  const resourceDir = join(root, '.a3/resources'), before = await readdir(resourceDir);
  let document = await open('source.ts');
  assert.equal(document.canWrite, true); assert.equal(document.resourceId, null); assert.equal(document.revision, null);
  assert.equal(document.encoding, 'utf-8-bom');
  await save(manager, active.sessionId, document, document.content);
  assert.deepEqual(await readdir(resourceDir), before); assert.deepEqual(await readFile(join(root, 'source.ts')), Buffer.from(source));
  const next = document.content.replace('café', 'mañana');
  document = await save(manager, active.sessionId, document, next);
  assert.ok(document.resourceId); assert.equal(document.revision, 1);
  assert.equal((await readdir(resourceDir)).length, before.length + 1);
  assert.deepEqual(await readFile(join(root, 'source.ts')), Buffer.from('\ufeff' + next));
  const entry = (await manager.listExplorer(active.sessionId)).entries.find((e) => e.name === 'source.ts');
  await manager.renameExplorerItem(entry.id, 'renamed.ts', active.sessionId);
  const reopened = await manager.openCodeDocument(active.sessionId, { resourceId: document.resourceId });
  assert.equal(reopened.relativePath, 'renamed.ts'); assert.equal(reopened.resourceId, document.resourceId); assert.equal(reopened.content, next);
  const written = await save(manager, active.sessionId, reopened, next + '// sigue\r\n');
  assert.equal(written.revision, reopened.revision + 1);
});

test('real host edits preserve each supported encoding and separator, no-op revision stays stable', windows, async (t) => {
  const files = {}, cases = [];
  for (const encoding of ['utf-8', 'utf-8-bom', 'utf-16le-bom', 'utf-16be-bom']) for (const eol of ['\n', '\r\n']) {
    const name = `code-${cases.length}.py`, source = `name = "á 😀 日本語"${eol}`;
    files[name] = encodeCodeText(source, encoding); cases.push({ name, source, encoding, eol });
  }
  const { root, manager, active, open } = await setup(t, files);
  for (const c of cases) {
    const document = await open(c.name), next = c.source.replace('name', 'nombre');
    const saved = await save(manager, active.sessionId, document, next);
    assert.equal(saved.encoding, c.encoding); assert.equal(saved.content, next);
    const noop = await save(manager, active.sessionId, saved, next);
    assert.equal(noop.revision, saved.revision); assert.equal(noop.hash, saved.hash);
    assert.deepEqual(await readFile(join(root, c.name)), Buffer.from(encodeCodeText(next, c.encoding)));
    await assert.rejects(save(manager, active.sessionId, saved, next.replaceAll(c.eol, c.eol === '\n' ? '\r\n' : '\n')), { code: 'CODE_REPRESENTATION_CHANGED' });
  }
});

test('independent views and external replacements produce conflicts and preserve the newer bytes', windows, async (t) => {
  const { root, manager, active, open } = await setup(t, { 'code.rs': 'fn main() {}\n' });
  const first = await open('code.rs'), second = await open('code.rs');
  const saved = await save(manager, active.sessionId, second, 'fn main() { /* newer */ }\n');
  await assert.rejects(save(manager, active.sessionId, first, 'old draft\n'), { code: 'REVISION_CONFLICT' });
  assert.equal((await manager.reloadCodeDocument(active.sessionId, first.documentId)).content, saved.content);
  const external = 'fn main() { /* external */ }\n';
  await writeFile(join(root, 'replacement.tmp'), external); await rm(join(root, 'code.rs')); await rename(join(root, 'replacement.tmp'), join(root, 'code.rs'));
  await assert.rejects(save(manager, active.sessionId, saved, 'do not overwrite\n'), { code: 'REVISION_CONFLICT' });
  const latest = await manager.reloadCodeDocument(active.sessionId, saved.documentId);
  assert.equal(latest.content, external); assert.equal(latest.canWrite, false);
  assert.deepEqual(await readFile(join(root, 'code.rs')), Buffer.from(external));
});

test('readonly mount, missing/revoked roots and profile revocation are enforced by host', windows, async (t) => {
  const { root, tempRoot, manager, host, active, open } = await setup(t, { 'local.sql': 'select 1;\n' });
  const externalRoot = join(tempRoot, 'external'); await mkdir(externalRoot); const original = Buffer.from('SELECT "niño";\r\n');
  await writeFile(join(externalRoot, 'query.sql'), original);
  const mountId = id(9201), resourceId = id(9202);
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'mount.read', mode: 'direct' });
  await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot: externalRoot, permission: 'read-only' });
  // A descriptor arriving externally is incorporated only after closing/reopening the project.
  await manager.closeActive(active.sessionId);
  await writeFile(join(root, '.a3/resources', resourceId + '.json'), JSON.stringify({ schemaVersion: '1.0.0', id: resourceId, revision: 1, kind: 'mounted-file', mountId, path: 'query.sql', extensions: {} }));
  const reopened = (await manager.openFolder(root)).active, sessionId = reopened.sessionId;
  const mounted = await manager.openCodeDocument(sessionId, { resourceId });
  assert.equal(mounted.content, original.toString()); assert.equal(mounted.canWrite, false); assert.match(mounted.readOnlyReason, /Montaje/);
  await assert.rejects(save(manager, sessionId, mounted, 'SELECT 2;\r\n'), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(await readFile(join(externalRoot, 'query.sql')), original);
  await rename(externalRoot, join(tempRoot, 'moved-external'));
  await assert.rejects(manager.reloadCodeDocument(sessionId, mounted.documentId), /PATH_UNAVAILABLE/);
  assert.deepEqual(await readFile(join(tempRoot, 'moved-external/query.sql')), original);
  await host.capabilities.approveLocalMount({ root, projectId: host.projectId, mountId, selectedRoot: join(tempRoot, 'moved-external'), permission: 'read-only' });
  assert.equal((await manager.reloadCodeDocument(sessionId, mounted.documentId)).content, original.toString());
  await host.capabilities.revokeLocalMount({ root, projectId: host.projectId, mountId });
  await assert.rejects(manager.reloadCodeDocument(sessionId, mounted.documentId), /montaje|mount/);
  const item = (await manager.listExplorer(sessionId)).entries.find((e) => e.name === 'local.sql');
  const local = await manager.openCodeDocument(sessionId, { itemId: item.id }); assert.equal(local.canWrite, true);
  await host.capabilities.setProfile({ root, projectId: host.projectId, profile: 'consultar' });
  await assert.rejects(save(manager, sessionId, local, 'select 9;\n'), { code: 'PERMISSION_DENIED' });
  assert.equal(await readFile(join(root, 'local.sql'), 'utf8'), 'select 1;\n');
});

test('binary, mixed EOL, metadata and stale sessions cannot be written as code', windows, async (t) => {
  const files = { 'data.custom': 'hello 😀\n', 'binary.custom': Buffer.from([0, 65]), 'legacy.txt': Buffer.from([0xe9]), 'mixed.txt': 'a\r\nb\n' };
  const { root, manager, active, open } = await setup(t, files);
  const text = await open('data.custom'); assert.equal(text.canWrite, true);
  for (const name of ['binary.custom', 'legacy.txt', 'mixed.txt', 'a3.project.json']) {
    const before = await readFile(join(root, name)), doc = await open(name); assert.equal(doc.canWrite, false, name); assert.ok(doc.readOnlyReason);
    await assert.rejects(save(manager, active.sessionId, doc, 'do not write'), { code: 'PERMISSION_DENIED' });
    assert.deepEqual(await readFile(join(root, name)), before);
  }
  await manager.closeActive(active.sessionId);
  await assert.rejects(save(manager, active.sessionId, text, 'stale\n'), /sesión|proyecto/i);
});

test('a resource ID cannot bypass explorer secret/ignore exclusions or the project root', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  await writeFile(join(root, '.env.local'), 'private'); await writeFile(join(root, 'private.txt'), 'ignored');
  await writeFile(join(root, '.gitignore'), 'private.txt\n');
  for (const [index, path] of ['.env.local', 'private.txt'].entries()) await writeFile(join(root, '.a3/resources', id(9300 + index) + '.json'),
    JSON.stringify({ schemaVersion: '1.0.0', id: id(9300 + index), revision: 1, kind: 'project-file', path, extensions: {} }));
  const host = await fixtureHost(root), manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  for (const resourceId of [id(9300), id(9301)]) await assert.rejects(manager.openCodeDocument(active.sessionId, { resourceId }), /oculto|excluido/);
  await assert.rejects(manager.openCodeDocument(active.sessionId, { itemId: '../outside' }), { code: 'STALE_FILE_ID' });
});

test('canvas code node and explorer address the same resource/revision without copying the source', windows, async (t) => {
  const { manager, active } = await setup(t);
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'code', title: 'Python', position: { x: 1, y: 2 }, value: 'print("hola")\n', language: 'python' });
  const entity = canvas.entities.find((e) => e.title === 'Python');
  const doc = await manager.openCodeDocument(active.sessionId, { entityId: entity.id, resourceId: entity.contentResourceId });
  assert.equal(doc.languageHint, 'python'); const next = 'print("niño 😀")\n';
  const saved = await save(manager, active.sessionId, doc, next);
  const other = await manager.openCodeDocument(active.sessionId, { resourceId: entity.contentResourceId });
  assert.equal(other.content, next); assert.equal(other.resourceId, saved.resourceId); assert.equal(other.revision, saved.revision);
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'drawing', title: 'Vector', position: { x: 1, y: 3 }, value: '{"schemaVersion":"1.0.0","strokes":[]}\n' });
  const vector = canvas.entities.find((e) => e.title === 'Vector');
  const drawing = await manager.openCodeDocument(active.sessionId, { resourceId: vector.contentResourceId });
  assert.equal(drawing.canWrite, false); await assert.rejects(save(manager, active.sessionId, drawing, 'not a drawing'), { code: 'PERMISSION_DENIED' });
});

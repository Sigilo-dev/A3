import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };

test('E3-E3/A3-012/015: DSL and JSON imports create reusable C4 static views and preserve original source', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'structurizr-import');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const fixtures = [
    { kind: 'structurizr-dsl', title: 'A3 DSL', path: new URL('../../../fixtures/e3/structurizr/static-workspace.dsl', import.meta.url) },
    { kind: 'structurizr-json', title: 'A3 JSON', path: new URL('../../../fixtures/e3/structurizr/static-workspace.json', import.meta.url) }
  ];
  for (let index = 0; index < fixtures.length; index += 1) {
    const item = fixtures[index], original = await readFile(item.path, 'utf8');
    canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: item.kind, title: item.title,
      position: { x: 600 + index * 500, y: 300 }, value: original });
    let entity = canvas.entities.find((candidate) => candidate.title === item.title);
    assert.ok(entity);
    let preview = await manager.previewCanvasStructurizrImport(active.sessionId, W1, entity.id);
    assert.equal(preview.format, item.kind === 'structurizr-dsl' ? 'structurizr-dsl' : 'structurizr-json');
    assert.equal(preview.canApply, true, preview.message);
    assert.deepEqual(preview.views.map((view) => view.kind), ['context', 'containers']);
    assert.equal(preview.converted.filter((record) => record.kind === 'a3.c4.relationship').length, 2);
    const firstMapping = { ...preview.mapping }, importedViews = [...preview.views];
    for (let viewIndex = 0; viewIndex < importedViews.length; viewIndex += 1) {
      const view = importedViews[viewIndex];
      canvas = await manager.applyCanvasStructurizrImport(active.sessionId, W1, preview.token, 'source', view.key);
      entity = canvas.entities.find((candidate) => candidate.title === item.title);
      if (viewIndex + 1 < importedViews.length) {
        preview = await manager.previewCanvasStructurizrImport(active.sessionId, W1, entity.id);
        assert.deepEqual(preview.mapping, firstMapping);
      }
      const importedCanvas = await manager.loadCanvasWorkspace(active.sessionId, view.workspaceId);
      assert.equal(importedCanvas.placements.length, view.elements);
      assert.equal(importedCanvas.c4.relationViews.length, view.kind === 'context' ? 1 : 2);
      assert.equal(importedCanvas.c4.current.data.kind, view.kind);
    }
    entity = canvas.entities.find((candidate) => candidate.title === item.title);
    assert.equal(entity.properties['a3.diagram.authority'], 'source');
    assert.equal(entity.properties['a3.diagram.import'].format, preview.format);
    assert.equal((await manager.loadCanvasContent(active.sessionId, W1, entity.id, entity.contentResourceId)).text, original);
    const update = await manager.previewCanvasStructurizrImport(active.sessionId, W1, entity.id);
    assert.equal(update.mode, 'update');
    assert.deepEqual(update.mapping, firstMapping);
    assert.equal(update.converted.every((item) => item.action === 'unchanged'), true);
  }
});

test('E3-E3/A3-015: remote include reports denied network permission and cannot be applied by fetching it', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'structurizr-remote-include');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const source = `workspace "Local only" {\n model {\n  editor = person "Editor"\n  system = softwareSystem "System"\n  editor -> system "uses"\n }\n views {\n  systemContext system {\n   include *\n  }\n }\n}\n!includeurl https://example.invalid/remote.dsl\n`;
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'structurizr-dsl', title: 'Remote include', position: { x: 900, y: 500 }, value: source });
  const entity = canvas.entities.find((candidate) => candidate.title === 'Remote include');
  const preview = await manager.previewCanvasStructurizrImport(active.sessionId, W1, entity.id);
  assert.equal(preview.canApply, true, 'recognized local subset remains importable with the include reported as missing');
  assert.ok(preview.missingResources.some((item) => item.source.includes('https://') && /network.access/.test(item.reason)));
  const bytesBefore = await manager.loadCanvasContent(active.sessionId, W1, entity.id, entity.contentResourceId);
  await manager.applyCanvasStructurizrImport(active.sessionId, W1, preview.token, 'a3-model', preview.views[0].key);
  const bytesAfter = await manager.loadCanvasContent(active.sessionId, W1, entity.id, entity.contentResourceId);
  assert.equal(bytesAfter.text, bytesBefore.text);
});

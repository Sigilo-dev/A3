import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };

test('E3-D2/A3-015: Mermaid import previews a partial conversion, preserves bytes, maps IDs and explicitly switches authority', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'mermaid-import');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  let active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const source = 'flowchart TD\r\n  Idea[Idea] --> Work[Trabajo]\r\n  Work -.-> Idea\r\n';
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'mermaid', title: 'Diseño', position: { x: 650, y: 200 }, value: source });
  let mermaid = canvas.entities.find((entity) => entity.title === 'Diseño');
  let preview = await manager.previewCanvasMermaidImport(active.sessionId, W1, mermaid.id);
  assert.equal(preview.mode, 'new'); assert.equal(preview.canApply, true); assert.equal(preview.converted.length, 3);
  assert.equal(preview.unconverted.length, 1); assert.equal(preview.authority, 'source');
  assert.equal((await readFile(join(root, 'content', `${mermaid.contentResourceId}.mmd`), 'utf8')), source);
  canvas = await manager.applyCanvasMermaidImport(active.sessionId, W1, preview.token, 'source');
  const imported = canvas.entities.filter((entity) => entity.type === 'a3.conceptual.idea');
  assert.equal(imported.length, 2);
  assert.equal(canvas.conceptualRelations.length, 1);
  mermaid = canvas.entities.find((entity) => entity.id === mermaid.id);
  assert.equal(mermaid.properties['a3.diagram.authority'], 'source');

  preview = await manager.previewCanvasMermaidImport(active.sessionId, W1, mermaid.id);
  assert.equal(preview.mode, 'update'); assert.equal(preview.canApply, true);
  assert.equal(preview.converted.every((entry) => entry.action === 'unchanged'), true);
  const originalIds = new Set(imported.map((entity) => entity.id));
  canvas = await manager.applyCanvasMermaidImport(active.sessionId, W1, preview.token, 'a3-model');
  mermaid = canvas.entities.find((entity) => entity.id === mermaid.id);
  assert.equal(mermaid.properties['a3.diagram.authority'], 'a3-model');
  assert.deepEqual(new Set(canvas.entities.filter((entity) => entity.type === 'a3.conceptual.idea').map((entity) => entity.id)), originalIds);
  const readback = await manager.loadCanvasContent(active.sessionId, W1, mermaid.id, mermaid.contentResourceId);
  assert.equal(readback.text, source, 'authority changes and model writes never rewrite the original CRLF source');
  assert.equal(readback.state, 'ready');
  await manager.closeActive(active.sessionId);
  active = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  assert.deepEqual(new Set(canvas.entities.filter((entity) => entity.type === 'a3.conceptual.idea').map((entity) => entity.id)), originalIds,
    'the native model and stable ID mapping round-trip through a project reopen');
  mermaid = canvas.entities.find((entity) => entity.id === mermaid.id);
  const reopenedSource = await manager.loadCanvasContent(active.sessionId, W1, mermaid.id, mermaid.contentResourceId);
  assert.equal(reopenedSource.text, source);
});

test('E3-D2/A3-015: unsupported diagram family and byte changes cannot be applied from a stale preview', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'mermaid-import-conflict');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'mermaid', title: 'No compatible', position: { x: 800, y: 200 }, value: 'sequenceDiagram\n A->>B: hello\n' });
  const entity = canvas.entities.find((item) => item.title === 'No compatible');
  const rejected = await manager.previewCanvasMermaidImport(active.sessionId, W1, entity.id);
  assert.equal(rejected.canApply, false); assert.equal(rejected.family, null); assert.equal(rejected.unconverted[0].line, 1);

  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'mermaid', title: 'Flow', position: { x: 1200, y: 200 }, value: 'flowchart TD\n A --> B\n' });
  const flow = canvas.entities.find((item) => item.title === 'Flow');
  const preview = await manager.previewCanvasMermaidImport(active.sessionId, W1, flow.id);
  await writeFile(join(root, 'content', `${flow.contentResourceId}.mmd`), 'flowchart TD\n A --> C\n', 'utf8');
  await assert.rejects(manager.applyCanvasMermaidImport(active.sessionId, W1, preview.token, 'a3-model'), /cambió después de la vista previa/);
  assert.equal(await readFile(join(root, 'content', `${flow.contentResourceId}.mmd`), 'utf8'), 'flowchart TD\n A --> C\n');
});

test('E3-D2/A3-013/015: class and ER fixtures apply through their native validators', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'mermaid-native-imports');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  for (const family of ['class', 'er']) {
    const source = await readFile(new URL(`../../../fixtures/e3/mermaid/import-${family}.mmd`, import.meta.url), 'utf8');
    canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'mermaid', title: `${family} source`, position: { x: family === 'class' ? 1500 : 1900, y: 400 }, value: source });
    const entity = canvas.entities.find((item) => item.title === `${family} source`);
    const preview = await manager.previewCanvasMermaidImport(active.sessionId, W1, entity.id);
    assert.equal(preview.family, family); assert.equal(preview.canApply, true);
    canvas = await manager.applyCanvasMermaidImport(active.sessionId, W1, preview.token, 'a3-model');
    if (family === 'class') { assert.equal(canvas.uml.elements.length, 3); assert.equal(canvas.uml.relationships.length, 2); assert.equal(canvas.uml.relationViews.length, 2); }
    else { assert.equal(canvas.er.elements.length, 2); assert.equal(canvas.er.relationships.length, 1); assert.equal(canvas.er.relationViews.length, 1); }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalProjectManager } from '../dist/index.js';
import { fixtureHost, scratch, W1 } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };

test('E3-E2/A3-013/015: PlantUML import previews class UML, preserves source, maps stable IDs and requires an explicit authority choice', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'plantuml-class-import');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const source = await readFile(new URL('../../../fixtures/e3/plantuml/import-class.puml', import.meta.url), 'utf8');
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'plantuml', title: 'Modelo de clases', position: { x: 2600, y: 400 }, value: source });
  let plantuml = canvas.entities.find((entity) => entity.title === 'Modelo de clases');
  let preview = await manager.previewCanvasPlantUmlImport(active.sessionId, W1, plantuml.id);
  assert.equal(preview.family, 'class'); assert.equal(preview.mode, 'new'); assert.equal(preview.canApply, true);
  assert.equal(preview.converted.filter((entry) => entry.kind.startsWith('a3.uml.')).length, 18);
  assert.equal(preview.unconverted.length, 0); assert.equal(preview.idConflicts.length, 0);
  const originalMapping = { ...preview.mapping };
  const sourcePath = join(root, 'content', `${plantuml.contentResourceId}.puml`);
  assert.equal(await readFile(sourcePath, 'utf8'), source);

  canvas = await manager.applyCanvasPlantUmlImport(active.sessionId, W1, preview.token, 'source');
  assert.equal(canvas.uml.elements.length, 12);
  assert.equal(canvas.uml.relationships.length, 6);
  plantuml = canvas.entities.find((entity) => entity.title === 'Modelo de clases');
  assert.equal(plantuml.properties['a3.diagram.authority'], 'source');
  assert.equal(plantuml.properties['a3.diagram.import'].format, 'plantuml');
  assert.equal(await readFile(sourcePath, 'utf8'), source);

  preview = await manager.previewCanvasPlantUmlImport(active.sessionId, W1, plantuml.id);
  assert.equal(preview.mode, 'update'); assert.equal(preview.canApply, true);
  assert.deepEqual(preview.mapping, originalMapping);
  assert.equal(preview.converted.every((entry) => entry.action === 'unchanged'), true, 'updating reuses the stored mapping and presents a no-op diff');
  canvas = await manager.applyCanvasPlantUmlImport(active.sessionId, W1, preview.token, 'a3-model');
  plantuml = canvas.entities.find((entity) => entity.title === 'Modelo de clases');
  assert.equal(plantuml.properties['a3.diagram.authority'], 'a3-model', 'authority changes only after the explicit user choice');
  assert.equal(await readFile(sourcePath, 'utf8'), source, 'editing the model never regenerates or overwrites original PlantUML');

  const oldAccountId = canvas.entities.find((entity) => entity.type === 'a3.uml.class' && entity.title === 'Account').id;
  await manager.closeActive(active.sessionId);
  const changedSource = source.replaceAll('Account', 'AccountRecord');
  await writeFile(sourcePath, changedSource, 'utf8');
  const reopened = (await manager.openFolder(root)).active;
  canvas = await manager.loadCanvasWorkspace(reopened.sessionId, W1);
  plantuml = canvas.entities.find((entity) => entity.title === 'Modelo de clases');
  preview = await manager.previewCanvasPlantUmlImport(reopened.sessionId, W1, plantuml.id);
  assert.equal(preview.mode, 'update'); assert.equal(preview.canApply, true);
  assert.equal(preview.converted.some((item) => item.title === 'AccountRecord' && item.action === 'create'), true);
  assert.equal(preview.staleSourceKeys.some((key) => key.includes('Account')), true);
  assert.equal(preview.mapping['entity:node:AccountRecord'] === oldAccountId, false, 'renames require an explicit mapping review and do not guess identity');
  canvas = await manager.applyCanvasPlantUmlImport(reopened.sessionId, W1, preview.token, 'a3-model');
  assert.equal(canvas.entities.some((entity) => entity.id === oldAccountId && entity.title === 'Account'), true, 'stale imported entities are reported and retained, not deleted');
  assert.equal(canvas.entities.some((entity) => entity.type === 'a3.uml.class' && entity.title === 'AccountRecord'), true);
  assert.equal(await readFile(sourcePath, 'utf8'), changedSource, 'importing a changed source still never rewrites it');
});

test('E3-E2/A3-015: partial PlantUML import reports unsupported constructs and rejects a stale source preview without writing', windows, async (t) => {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'plantuml-partial-import');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const active = (await manager.openFolder(root)).active;
  let canvas = await manager.loadCanvasWorkspace(active.sessionId, W1);
  const partial = await readFile(new URL('../../../fixtures/e3/plantuml/import-partial.puml', import.meta.url), 'utf8');
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'plantuml', title: 'Importación parcial', position: { x: 3000, y: 400 }, value: partial });
  const partialSource = canvas.entities.find((entity) => entity.title === 'Importación parcial');
  const partialPreview = await manager.previewCanvasPlantUmlImport(active.sessionId, W1, partialSource.id);
  assert.equal(partialPreview.canApply, true);
  assert.equal(partialPreview.unconverted.some((issue) => issue.source.startsWith('skinparam')), true);
  assert.equal(partialPreview.unconverted.some((issue) => issue.source.startsWith('note')), true);
  assert.equal(partialPreview.unconverted.some((issue) => issue.source.startsWith('package')), true);
  assert.equal(partialPreview.missingResources.length, 2);
  assert.equal(partialPreview.converted.length, 3, 'only the two classes and their relationship enter the model');

  const source = await readFile(new URL('../../../fixtures/e3/plantuml/import-class.puml', import.meta.url), 'utf8');
  canvas = await manager.createCanvasContentNode(active.sessionId, W1, canvas.revision, { kind: 'plantuml', title: 'Fuente con conflicto', position: { x: 3400, y: 400 }, value: source });
  const conflictedSource = canvas.entities.find((entity) => entity.title === 'Fuente con conflicto');
  const preview = await manager.previewCanvasPlantUmlImport(active.sessionId, W1, conflictedSource.id);
  const sourcePath = join(root, 'content', `${conflictedSource.contentResourceId}.puml`);
  const changedSource = source.replace('class Account {', 'class Account {\n  +active: Boolean');
  await writeFile(sourcePath, changedSource, 'utf8');
  await assert.rejects(manager.applyCanvasPlantUmlImport(active.sessionId, W1, preview.token, 'a3-model'), /cambió después de la vista previa/);
  assert.equal(await readFile(sourcePath, 'utf8'), changedSource, 'a stale import never writes over external source edits');
});

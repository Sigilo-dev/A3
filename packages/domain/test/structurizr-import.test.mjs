import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseStructurizrDslImport, parseStructurizrJsonImport } from '../dist/src/index.js';

const dslPath = new URL('../../../fixtures/e3/structurizr/static-workspace.dsl', import.meta.url);
const jsonPath = new URL('../../../fixtures/e3/structurizr/static-workspace.json', import.meta.url);

test('E3-E3: DSL and JSON adapters preserve distinct source formats and expose static C4 views', async () => {
  const dsl = parseStructurizrDslImport(await readFile(dslPath, 'utf8'));
  const json = parseStructurizrJsonImport(await readFile(jsonPath, 'utf8'));
  assert.equal(dsl.format, 'structurizr-dsl');
  assert.equal(json.format, 'structurizr-json');
  for (const graph of [dsl, json]) {
    assert.equal(graph.elements.length, 3);
    assert.equal(graph.relations.length, 2);
    assert.deepEqual(graph.views.map((view) => view.kind), ['context', 'containers']);
    assert.deepEqual(graph.idConflicts, []);
    assert.equal(graph.views[0].elements.some((key) => key.startsWith('container:')), false, 'context view omits containers');
    assert.equal(graph.views[1].elements.some((key) => key.startsWith('container:')), true, 'container view includes its descendants');
  }
  assert.ok(json.unconverted.some((item) => item.source === 'dynamicViews'));
  assert.ok(json.unconverted.some((item) => item.source === 'views.configuration'));
  assert.ok(dsl.unconverted.some((item) => item.source === 'autoLayout lr'));
});

test('E3-E3: malformed JSON reports a line and leaves source management to the caller', () => {
  const graph = parseStructurizrJsonImport('{\n  "model": {\n    "people": [}\n  }\n}');
  assert.equal(graph.elements.length, 0);
  assert.ok(graph.unconverted[0].line >= 3);
  assert.match(graph.unconverted[0].reason, /JSON de Structurizr inválido/);
});

test('E3-E3: DSL scripts never execute and remote/local includes stay unresolved', () => {
  const graph = parseStructurizrDslImport(`workspace "safe" {\n model {\n  person = person "Editor"\n }\n !includeurl https://example.invalid/workspace.dsl\n !script groovy { println("never") }\n}`);
  assert.ok(graph.missingResources.some((item) => item.source.includes('https://') && /Include remoto/.test(item.reason)));
  assert.ok(graph.unconverted.some((item) => /nunca se ejecutan/.test(item.reason)));
  assert.equal(graph.elements.length, 1);
});

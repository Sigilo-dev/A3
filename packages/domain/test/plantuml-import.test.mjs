import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildMermaidImportRecords, requiredMermaidMapping } from '../dist/src/mermaid-import.js';
import { parsePlantUmlClassImport } from '../dist/src/plantuml-import.js';

const fixture = (name) => readFile(new URL(`../../../fixtures/e3/plantuml/import-${name}.puml`, import.meta.url), 'utf8');
let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
const mappingFor = (graph) => Object.fromEntries(requiredMermaidMapping(graph).map((key) => [key, uuid()]));

test('E3-E2/A3-013/015: PlantUML class/interface and six basic relationship types map into UML while source syntax stays untouched', async () => {
  const source = await fixture('class');
  const before = Buffer.from(source, 'utf8');
  const graph = parsePlantUmlClassImport(source);
  assert.equal(graph.family, 'class');
  assert.equal(graph.nodes.length, 12);
  assert.equal(graph.relations.length, 6);
  assert.equal(graph.unconverted.length, 0);
  assert.equal(graph.idConflicts.length, 0);
  const account = graph.nodes.find((node) => node.id === 'Account');
  assert.equal(account?.attributes?.[0]?.type.name, 'UUID');
  assert.equal(account?.methods?.[0]?.parameters[0]?.type.name, 'String');
  assert.equal(graph.nodes.find((node) => node.id === 'Repository')?.umlKind, 'interface');
  const plan = buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph), 'plantuml');
  assert.equal(plan.records.filter((record) => record.kind === 'entity').length, 12);
  assert.equal(plan.records.some((record) => record.kind === 'entity' && record.value.type === 'a3.uml.interface'), true);
  assert.deepEqual(new Set(plan.records.filter((record) => record.kind === 'relation').map((record) => record.value.type)), new Set([
    'a3.uml.association', 'a3.uml.dependency', 'a3.uml.generalization', 'a3.uml.realization', 'a3.uml.aggregation', 'a3.uml.composition'
  ]));
  assert.equal(plan.records.every((record) => 'a3.plantuml.import' in record.value.extensions), true);
  assert.equal(source, before.toString('utf8'), 'parsing/building never writes or normalizes canonical source bytes');
});

test('E3-E2/A3-015: unsupported constructs are reported as retained source and supported declarations remain previewable', async () => {
  const source = await fixture('partial');
  const graph = parsePlantUmlClassImport(source);
  assert.equal(graph.family, 'class');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.unconverted.some((item) => item.source.startsWith('skinparam')), true);
  assert.equal(graph.unconverted.some((item) => item.source.startsWith('note')), true);
  assert.equal(graph.unconverted.some((item) => item.source.startsWith('package')), true);
  assert.equal(graph.missingResources.length, 2, 'local and remote include resources are reported but never followed');
  assert.equal(graph.idConflicts.length, 0);
});

test('E3-E2/A3-013/015: malformed syntax, duplicate identities, overloads, and conflicting classifier kinds block unsafe identities', async () => {
  const malformed = parsePlantUmlClassImport(await fixture('negative'));
  assert.equal(malformed.family, 'class');
  assert.ok(malformed.unconverted.length >= 2);
  const duplicate = parsePlantUmlClassImport('@startuml\nclass Thing\nclass thing\n@enduml\n');
  assert.equal(duplicate.idConflicts.length, 1);
  const overload = parsePlantUmlClassImport('@startuml\nclass Thing {\n+run(): Result\n+run(value: String): Result\n}\n@enduml\n');
  assert.equal(overload.idConflicts.length, 1);
  const kindConflict = parsePlantUmlClassImport('@startuml\nclass Thing\ninterface Thing\n@enduml\n');
  assert.equal(kindConflict.idConflicts.length, 1);
  assert.throws(() => buildMermaidImportRecords(duplicate, uuid(), uuid(), mappingFor(duplicate), 'plantuml'), /conflictos de identidad/);
});

test('E3-E2/A3-013: invalid realization endpoints and cyclic generalization are reported before apply', () => {
  const invalidRealization = parsePlantUmlClassImport('@startuml\nclass Concrete\nclass Contract\nConcrete ..|> Contract\n@enduml\n');
  assert.equal(invalidRealization.idConflicts.length, 1);
  assert.match(invalidRealization.idConflicts[0].reason, /interfaz destino/);
  const cycle = parsePlantUmlClassImport('@startuml\nclass A\nclass B\nA --|> B\nB --|> A\n@enduml\n');
  assert.equal(cycle.idConflicts.some((entry) => /ciclos/.test(entry.reason)), true);
});

test('E3-E2/A3-015: a one-line note is reported without hiding later supported declarations', () => {
  const graph = parsePlantUmlClassImport('@startuml\nclass Before\nnote right of Before: retained text\nclass After\n@enduml\n');
  assert.deepEqual(graph.nodes.map((node) => node.id), ['Before', 'After']);
  assert.equal(graph.unconverted.some((item) => item.source.startsWith('note right of Before')), true);
});

test('E3-E2/A3-015: non-class PlantUML families are never guessed from source text', () => {
  const graph = parsePlantUmlClassImport('@startmindmap\n* root\n@endmindmap\n');
  assert.equal(graph.family, null);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.unconverted.length > 0, true);
});

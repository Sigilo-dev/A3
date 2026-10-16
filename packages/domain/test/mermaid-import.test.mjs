import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildMermaidImportRecords, parseMermaidImport, requiredMermaidMapping } from '../dist/src/mermaid-import.js';

const fixture = (name) => readFile(new URL(`../../../fixtures/e3/mermaid/import-${name}.mmd`, import.meta.url), 'utf8');
let nextId = 1;
const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
const mappingFor = (graph) => Object.fromEntries(requiredMermaidMapping(graph).map((key) => [key, uuid()]));

test('E3-D2/A3-015: documented flowchart subset converts nodes and directed labeled links', async () => {
  const source = await fixture('flowchart');
  const graph = parseMermaidImport(source);
  assert.equal(graph.family, 'flowchart'); assert.equal(graph.nodes.length, 3); assert.equal(graph.relations.length, 2);
  assert.equal(graph.unconverted.length, 2, 'dotted edge and nonrectangular visual shape remain in source and are reported');
  assert.equal(graph.unconverted.some((item) => item.reason.includes('forma diamond')), true);
  const plan = buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph));
  assert.equal(plan.records.filter((record) => record.kind === 'entity').every((record) => record.value.type === 'a3.conceptual.idea'), true);
  assert.equal(plan.records.filter((record) => record.kind === 'relation').every((record) => record.value.type === 'a3.conceptual.relationship'), true);
  assert.equal(plan.records.some((record) => record.kind === 'visual-edge'), false, 'semantic concept links are not canvas-only edges');
});

test('E3-D2/A3-013/015: documented class subset maps members and inheritance/composition', async () => {
  const graph = parseMermaidImport(await fixture('class'));
  assert.equal(graph.family, 'class'); assert.equal(graph.nodes.length, 3); assert.equal(graph.relations.length, 2);
  assert.equal(graph.nodes.find((node) => node.id === 'Account').attributes.length, 1);
  assert.equal(graph.nodes.find((node) => node.id === 'Account').methods[0].parameters.length, 1);
  const plan = buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph));
  const account = plan.records.find((record) => record.kind === 'entity' && record.value.title === 'Account');
  assert.equal(account.value.type, 'a3.uml.class');
  assert.match(account.value.properties['a3.uml'].attributes[0].id, /^[0-9a-f-]{36}$/i);
  assert.equal(plan.records.find((record) => record.kind === 'relation' && record.value.type === 'a3.uml.generalization').value.source.entityId,
    plan.records.find((record) => record.kind === 'entity' && record.value.title === 'Admin').value.id);
  const accountId = plan.records.find((record) => record.kind === 'entity' && record.value.title === 'Account').value.id;
  const owns = plan.records.find((record) => record.kind === 'relation' && record.value.type === 'a3.uml.composition');
  assert.equal(owns.value.source.entityId, accountId);
  assert.equal(owns.value.properties['a3.uml'].source.multiplicity.upper, 1);
  const reversed = parseMermaidImport('classDiagram\n  Part --* Whole\n');
  assert.equal(reversed.relations[0].source, 'Whole', 'composition is oriented toward the whole marked by the diamond');
});

test('E3-D2/A3-013/015: ER subset preserves keys and endpoint cardinality; unresolved FK is reported', async () => {
  const graph = parseMermaidImport(await fixture('er'));
  assert.equal(graph.family, 'er'); assert.equal(graph.nodes.length, 2); assert.equal(graph.relations.length, 1);
  assert.deepEqual([graph.relations[0].sourceCardinality, graph.relations[0].targetCardinality], ['one', 'zero-or-many']);
  assert.equal(graph.unconverted.some((item) => item.source.includes('FK') && item.reason.includes('referencia')), true);
  const plan = buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph));
  const user = plan.records.find((record) => record.kind === 'entity' && record.value.title === 'USER');
  assert.equal(user.value.properties['a3.er'].fields.find((field) => field.name === 'id').primaryKey, true);
  assert.equal(user.value.properties['a3.er'].fields.find((field) => field.name === 'email').unique, true);
  assert.equal(user.value.properties['a3.er'].fields.some((field) => field.name === 'group_id'), false, 'unsupported FK semantics are not reduced to a plain field');
});

test('E3-D2/A3-015: unsafe directives, malformed lines, duplicate IDs and unverified assets stay reported', async () => {
  const source = await fixture('negative');
  const graph = parseMermaidImport(source);
  assert.equal(graph.family, 'flowchart');
  assert.equal(graph.unconverted.some((item) => item.source.includes('%%{init')), true);
  assert.equal(graph.unconverted.some((item) => item.reason.includes('Fuera del subconjunto')), true);
  assert.equal(graph.idConflicts.length, 1);
  assert.equal(graph.missingResources.length, 1);
  assert.throws(() => buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph)), /conflictos de identidad/);
});

test('E3-D2/A3-015: unknown headers are not guessed from a successful renderer', () => {
  const graph = parseMermaidImport('sequenceDiagram\n A->>B: hi\n');
  assert.equal(graph.family, null); assert.equal(graph.nodes.length, 0); assert.equal(graph.relations.length, 0);
  assert.match(graph.unconverted[0].reason, /cabecera/);
});

test('E3-D2/A3-015: IDs that differ only by case block import rather than silently aliasing', () => {
  const graph = parseMermaidImport('flowchart LR\n  Node --> node\n');
  assert.equal(graph.idConflicts.length, 1);
  assert.match(graph.idConflicts[0].reason, /mayúsculas\/minúsculas/);
  assert.throws(() => buildMermaidImportRecords(graph, uuid(), uuid(), mappingFor(graph)), /conflictos de identidad/);
});

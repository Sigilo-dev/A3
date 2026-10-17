import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { exportChecklistMarkdown, inspectChecklistMarkdown, planChecklistImport, projectPlanningTraceability, PLANNING_KEY, PLANNING_HISTORY_KEY } from '../dist/src/index.js';
import { fixture, id, E1, W1, W2 } from './fixture.mjs';
const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const markdown = await readFile(new URL('../../../fixtures/e4/planning/checklist.md', import.meta.url), 'utf8');
const initial = () => ({ records: [...fixture().records, ...structuredClone(records)] });
const task = (s, entityId = scenario.taskId) => s.records.find((r) => r.kind === 'entity' && r.value.id === entityId).value;
const ids = [scenario.taskId, scenario.dependentId];
const importAll = (preview) => preview.rows.map((row) => ({ id: row.id, decision: 'import' }));

test('A3-021: versioned Markdown round-trip retains IDs, references, unknown fields and every task state without mutation', () => {
  const snapshot = initial(), before = structuredClone(snapshot);
  assert.equal(exportChecklistMarkdown(snapshot, ids), markdown);
  for (const state of ['todo', 'in_progress', 'blocked', 'done', 'cancelled']) {
    const copy = structuredClone(snapshot), entity = task(copy);
    entity.properties[PLANNING_KEY].state = state; entity.properties[PLANNING_HISTORY_KEY].at(-1).toState = state;
    entity.title = 'Unicode ñ <script> `[]` \\n real\nline'; entity.properties[PLANNING_KEY]['vendor.future'] = { value: '--><script>never execute</script>' };
    const source = exportChecklistMarkdown(copy, [entity.id]), preview = inspectChecklistMarkdown(copy, '\uFEFF' + source.replace(/\n/g, '\r\n'));
    assert.deepEqual(preview.issues, []); assert.equal(preview.rows[0].match, 'unchanged');
    assert.equal(preview.rows[0].incoming.title, entity.title); assert.deepEqual(preview.rows[0].incoming.data, entity.properties[PLANNING_KEY]);
    assert.deepEqual(planChecklistImport(copy, preview.rows, importAll(preview)), { operations: [], issues: [] });
    assert.ok(!source.includes('--><script>'));
  }
  assert.deepEqual(snapshot, before);
});

test('edited checkbox/title matches by stable ID; stale revisions require conflict decision and occupied IDs never match titles', () => {
  const state = initial(), edited = markdown.replace('- [ ] Probar', '- [x] Probar');
  const preview = inspectChecklistMarkdown(state, edited); assert.deepEqual(preview.issues, []); assert.equal(preview.rows[0].match, 'update');
  assert.equal(planChecklistImport(state, preview.rows, importAll(preview)).operations[0].data.state, 'done');
  task(state).revision++;
  const stale = inspectChecklistMarkdown(state, edited); assert.equal(stale.rows[0].match, 'conflict');
  assert.equal(stale.rows[0].current.revision, 2);
  assert.equal(planChecklistImport(state, stale.rows, stale.rows.map((row) => ({ id: row.id, decision: 'keep' }))).operations.length, 0);
  assert.equal(planChecklistImport(state, stale.rows, importAll(stale)).operations[0].expectedRevision, 2);
  const collision = inspectChecklistMarkdown(state, markdown.replaceAll(scenario.taskId, E1));
  assert.equal(collision.rows[0].match, 'blocked'); assert.match(collision.rows[0].issues.join(), /ID ocupado/);
});

test('syntax, duplicated ID, broken reference, cycle, foreign context and oversized batches are diagnosed without discarding source', () => {
  const state = initial();
  const variants = [markdown.replace('"version":"1.0.0"', '"version":"9.0.0"'), markdown + markdown, markdown.replace('"references":[', '"references":[{"kind":"resource","id":"' + id(99999) + '"},'),
    markdown.replace('"dependencyIds":[]', '"dependencyIds":["' + scenario.taskId + '"]'), markdown.replace('00000000-0000-4000-8000-000000000001', id(99999)),
    markdown.replace('"priority":"high"', '"priority":null'), '- [ ] Missing identity', markdown + '\n<script>never execute</script>', 'x'.repeat(256 * 1024 + 1)];
  for (const source of variants) assert.ok(inspectChecklistMarkdown(state, source).issues.length, source.slice(0, 200));
  const before = structuredClone(state); inspectChecklistMarkdown(state, variants[2]); assert.deepEqual(state, before);
  assert.throws(() => exportChecklistMarkdown(state, Array.from({ length: 129 }, (_, n) => id(n))), /128/);
  const unicode = initial(); task(unicode).properties[PLANNING_KEY].future = 'é'.repeat(128 * 1024);
  assert.throws(() => exportChecklistMarkdown(unicode, [scenario.taskId]), /256 KiB UTF-8/);
  // Foreign projects with coincident entity IDs still cannot share exchange context.
  const other = initial(); other.records.find((r) => r.kind === 'project').value.projectId = id(99998);
  assert.match(inspectChecklistMarkdown(other, markdown).issues.join(), /otro proyecto/);
});

test('traceability derives story/task/criterion/evidence/resource/placement links, flags broken targets and never follows visual edges', () => {
  const snapshot = initial();
  for (const [index, workspaceId] of [W1, W2].entries()) snapshot.records.push({ kind: 'placement', workspaceId, value: { schemaVersion: '1.0.0', id: id(7500 + index), revision: 1, entityId: scenario.taskId, position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, style: {}, extensions: {} } });
  const data = task(snapshot).properties[PLANNING_KEY]; data.evidenceIds = [scenario.evidenceIds[0]]; data.references.push({ kind: 'resource', id: id(99997) });
  const projection = projectPlanningTraceability(snapshot), row = projection.rows.find((r) => r.id === scenario.taskId);
  assert.equal(row.links.filter((link) => link.role === 'nodo').length, 2); assert.equal(row.links.filter((link) => link.role === 'historia').length, 1);
  assert.ok(row.links.some((link) => link.role === 'evidencia')); assert.ok(row.links.some((link) => link.missing && link.id === id(99997)));
  assert.ok(projection.rows.find((r) => r.id === scenario.evidenceIds[0]).links.some((link) => link.kind === 'resource' && !link.missing));
  assert.equal(projection.criteriaWithoutEvidence.length, 0);
  assert.equal(projection.rows.some((r) => r.kind === 'visual-edge'), false);
});

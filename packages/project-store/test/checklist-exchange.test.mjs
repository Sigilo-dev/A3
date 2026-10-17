import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { LocalProjectManager } from '../dist/index.js';
import { scratch, fixtureHost, id, E1, W1 } from './fixture.mjs';
const records = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/records.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/planning/scenario.json', import.meta.url), 'utf8'));
const markdown = await readFile(new URL('../../../fixtures/e4/planning/checklist.md', import.meta.url), 'utf8');
const windows = { skip: process.platform !== 'win32' };
async function setup(t) {
  const { root, tempRoot } = await scratch(t); await mkdir(join(root, 'assets'), { recursive: true });
  await cp(new URL('../../../fixtures/e4/planning/planning-capture.svg', import.meta.url), join(root, 'assets/planning-capture.svg'));
  for (const record of records) await writeFile(join(root, '.a3', record.kind === 'entity' ? 'entities' : 'resources', record.value.id + '.json'), JSON.stringify(record.value, null, 2) + '\n');
  const host = await fixtureHost(root, 'exchange-person'), manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const sessionId = (await manager.openFolder(root)).active.sessionId; return { root, tempRoot, manager, sessionId, host };
}
const task = (state) => state.items.find((item) => item.id === scenario.taskId);
const importAll = (preview) => preview.rows.map((row) => ({ id: row.id, decision: 'import' }));
const changed = markdown.replace('- [ ] Probar', '- [x] Probar');

test('A3-021: offline export/preview/import persists a shared task and host actor, with no second file or no-op rewrite', windows, async (t) => {
  const { root, manager, sessionId, host } = await setup(t), taskPath = join(root, '.a3/entities', scenario.taskId + '.json');
  const original = await readFile(taskPath), description = await readFile(join(root, 'pages/readme.md'));
  assert.equal((await manager.exportPlanningChecklist(sessionId, [scenario.taskId, scenario.dependentId])).markdown, markdown);
  let preview = await manager.previewPlanningChecklist(sessionId, markdown); assert.ok(preview.token); assert.deepEqual(preview.issues, []);
  await manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)); assert.deepEqual(await readFile(taskPath), original);
  preview = await manager.previewPlanningChecklist(sessionId, changed); assert.equal(preview.rows[0].match, 'update');
  assert.equal(task(await manager.loadPlanning(sessionId)).data.state, 'todo', 'preview does not write');
  const state = await manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview));
  assert.equal(task(state).data.state, 'done'); assert.equal(task(state).revision, 2); assert.deepEqual(task(state).history.at(-1).actor, host.authenticatedActor);
  assert.equal(task(state).data.storyId, scenario.storyId); assert.equal(task(state).data.references[0].id, E1);
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)), { code: 'CHECKLIST_PREVIEW_MISSING' });
  const saved = await readFile(taskPath); preview = await manager.previewPlanningChecklist(sessionId, changed);
  assert.equal(preview.rows[0].match, 'unchanged'); await manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)); assert.deepEqual(await readFile(taskPath), saved);
  const placement = await manager.showPlanningTask(sessionId, scenario.taskId, W1);
  const trace = (await manager.loadPlanning(sessionId)).traceability.rows.find((row) => row.id === scenario.taskId);
  assert.ok(trace.links.some((link) => link.kind === 'placement' && link.id === placement.placementId));
  await manager.closeActive(sessionId); const reopened = (await manager.openFolder(root)).active.sessionId;
  assert.equal(task(await manager.loadPlanning(reopened)).data.state, 'done');
  assert.deepEqual(await readFile(join(root, 'pages/readme.md')), description); assert.ok(!(await readdir(root)).includes('a3-checklist.md'));
});

test('source revision conflict compares both versions; explicit keep/import and stale preview never overwrite unseen changes', windows, async (t) => {
  const { manager, sessionId } = await setup(t);
  await manager.updatePlanningTask(sessionId, { entityId: scenario.taskId, expectedRevision: 1, state: 'in_progress', evidenceIds: [] });
  let preview = await manager.previewPlanningChecklist(sessionId, changed); assert.equal(preview.rows[0].match, 'conflict'); assert.ok(preview.token);
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, []), { code: 'CHECKLIST_CHOICES_REQUIRED' });
  await manager.applyPlanningChecklist(sessionId, preview.token, preview.rows.map((row) => ({ id: row.id, decision: 'keep' })));
  assert.equal(task(await manager.loadPlanning(sessionId)).data.state, 'in_progress');
  preview = await manager.previewPlanningChecklist(sessionId, changed);
  await manager.createPlanningTask(sessionId, 'Cambio posterior');
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)), { code: 'REVISION_CONFLICT' });
  preview = await manager.previewPlanningChecklist(sessionId, changed);
  const state = await manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)); assert.equal(task(state).data.state, 'done'); assert.equal(task(state).revision, 3);
});

test('broken references, duplicate IDs, foreign project and occupied identity cannot yield an applicable preview', windows, async (t) => {
  const { manager, sessionId } = await setup(t), before = await manager.loadPlanning(sessionId);
  const invalid = [markdown + markdown, markdown.replace('"references":[', '"references":[{"kind":"resource","id":"' + id(99999) + '"},'),
    markdown.replaceAll(scenario.taskId, E1), markdown.replace(before.projectId, id(99998))];
  for (const source of invalid) {
    const preview = await manager.previewPlanningChecklist(sessionId, source); assert.equal(preview.token, null); assert.ok(preview.issues.length || preview.rows.some((row) => row.issues.length));
  }
  assert.deepEqual((await manager.loadPlanning(sessionId)).items, before.items);
});

test('explicit new identity creates only the reviewed task; existing evidence policy still blocks done without proof', windows, async (t) => {
  const { manager, sessionId } = await setup(t);
  const single = (await manager.exportPlanningChecklist(sessionId, [scenario.taskId])).markdown;
  let preview = await manager.previewPlanningChecklist(sessionId, single.replaceAll(scenario.taskId, id(7900)));
  assert.equal(preview.rows[0].match, 'create');
  let state = await manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)); assert.ok(state.items.some((item) => item.id === id(7900) && item.data.state === 'todo'));
  state = await manager.setPlanningPolicy(sessionId, state.projectRevision, true);
  preview = await manager.previewPlanningChecklist(sessionId, changed);
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)), /planning-evidence-required/);
  assert.equal(task(await manager.loadPlanning(sessionId)).data.state, 'todo');
});

test('revoked capabilities and reopened project sessions cannot reuse an import token or export data', windows, async (t) => {
  const { manager, sessionId, root, host } = await setup(t);
  const preview = await manager.previewPlanningChecklist(sessionId, changed);
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'task.edit', mode: 'deny' });
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)), { code: 'PERMISSION_DENIED' });
  await host.capabilities.setGrant({ root, projectId: host.projectId, capability: 'export', mode: 'deny' });
  await assert.rejects(manager.exportPlanningChecklist(sessionId, [scenario.taskId]), { code: 'PERMISSION_DENIED' });
  await manager.closeActive(sessionId); const reopened = (await manager.openFolder(root)).active.sessionId;
  await assert.rejects(manager.applyPlanningChecklist(sessionId, preview.token, importAll(preview)), { code: 'STALE_SESSION' });
  await assert.rejects(manager.applyPlanningChecklist(reopened, preview.token, importAll(preview)), { code: 'CHECKLIST_PREVIEW_MISSING' });
});

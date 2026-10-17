import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { LocalProjectManager, sha256 } from '../dist/index.js';
import { scratch, fixtureHost, E1, W1 } from './fixture.mjs';
const W2 = '00000000-0000-4000-8000-000000000007';
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/variables/scenario.json', import.meta.url), 'utf8'));
const templateCases = JSON.parse(await readFile(new URL('../../../fixtures/e4/variables/template-cases.json', import.meta.url), 'utf8'));
const promptCases = JSON.parse(await readFile(new URL('../../../fixtures/e4/prompts/template-cases.json', import.meta.url), 'utf8'));
const windows = { skip: process.platform !== 'win32' };
async function project(t) {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'typed-variables');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host }); t.after(() => manager.dispose());
  const session = (await manager.openFolder(root)).active; return { root, tempRoot, host, manager, sessionId: session.sessionId, projectId: host.projectId };
}
async function put(c, scope, variables, expectedRevision = null, query = {}) { return c.manager.setProjectVariables(c.sessionId, { scope, variables: structuredClone(variables), expectedRevision }, query); }
const effective = (state, name = 'demo.name') => state.effective.find((entry) => entry.name === name).result;

test('A3-018/A3-004: project/workspace/entity values, bound labels and ID references survive reopen without changing Markdown', windows, async (t) => {
  const c = await project(t), { manager, root, projectId } = c;
  const descriptor = JSON.parse(await readFile(join(root, '.a3/resources/00000000-0000-4000-8000-000000000004.json'), 'utf8'));
  const sourcePath = join(root, descriptor.path), source = await readFile(sourcePath);
  let state = await put(c, { kind: 'project', ownerId: projectId }, scenario.project);
  await put(c, { kind: 'workspace', ownerId: W1 }, scenario.firstWorkspace); await put(c, { kind: 'workspace', ownerId: W2 }, scenario.secondWorkspace);
  state = await manager.loadProjectVariables(c.sessionId, { entityId: E1, workspaceId: W1 });
  const revision = state.entities.find((e) => e.id === E1).revision;
  await manager.bindProjectVariable(c.sessionId, E1, revision, 'a3.display.label', { kind: 'variable', name: 'demo.name' }, { workspaceId: W1, entityId: E1 });
  const first = await manager.loadCanvasWorkspace(c.sessionId, W1), second = await manager.loadCanvasWorkspace(c.sessionId, W2);
  assert.equal(first.entities.find((e) => e.id === E1).displayTitle, 'first workspace'); assert.equal(second.entities.find((e) => e.id === E1).displayTitle, 'second workspace');
  assert.equal(first.entities.find((e) => e.id === E1).title, second.entities.find((e) => e.id === E1).title);
  const entityFile = join(root, '.a3/entities', E1 + '.json'), beforeEntity = await readFile(entityFile);
  const stored = JSON.parse(await readFile(join(root, '.a3/variables/project.json'), 'utf8')); stored.extensions['fixture.future'] = { keep: true }; stored.variables[0].source.future = { keep: 'source' };
  // Use a closed lease to simulate a normal external update, then reopen and preserve it.
  await manager.closeActive(c.sessionId); await writeFile(join(root, '.a3/variables/project.json'), JSON.stringify(stored, null, 2)); c.sessionId = (await manager.openFolder(root)).active.sessionId;
  const changed = scenario.project.map((v) => v.name === 'demo.name' ? { ...v, source: { kind: 'literal', value: 'project changed' } } : v);
  await put(c, { kind: 'project', ownerId: projectId }, changed, 1);
  assert.deepEqual(await readFile(entityFile), beforeEntity); assert.deepEqual(await readFile(sourcePath), source);
  const saved = JSON.parse(await readFile(join(root, '.a3/variables/project.json'), 'utf8'));
  assert.deepEqual(saved.extensions['fixture.future'], { keep: true }); assert.deepEqual(saved.variables[0].source.future, { keep: 'source' });
  await put(c, { kind: 'entity', ownerId: E1 }, scenario.entity);
  const transient = await manager.loadProjectVariables(c.sessionId, { workspaceId: W2, entityId: E1, executionVariables: scenario.execution });
  assert.equal(effective(transient).value.scope.kind, 'execution'); assert.equal(effective(transient).value.value, 'temporary execution');
  assert.equal(effective(await manager.loadProjectVariables(c.sessionId, { workspaceId: W2, entityId: E1 })).value.scope.kind, 'entity');
  await manager.closeActive(c.sessionId); c.sessionId = (await manager.openFolder(root)).active.sessionId;
  assert.equal((await manager.loadCanvasWorkspace(c.sessionId, W2)).entities.find((e) => e.id === E1).displayTitle, 'entity override');
  assert.equal(effective(await manager.loadProjectVariables(c.sessionId), 'demo.resource').value.value.id, '00000000-0000-4000-8000-000000000004');
  assert.equal((await readdir(join(root, '.a3/variables'))).some((name) => /execution/.test(name)), false);
});

test('A3-018/A3-047: stale revision, invalid types/credential markers and revocation never change accepted bytes', windows, async (t) => {
  const c = await project(t), scope = { kind: 'project', ownerId: c.projectId };
  await put(c, scope, scenario.project); const path = join(c.root, '.a3/variables/project.json'), original = await readFile(path);
  await assert.rejects(put(c, scope, [], null), { code: 'REVISION_CONFLICT' });
  await assert.rejects(put(c, scope, [{ name: 'demo.bad', valueType: 'enum', enumValues: ['one'], source: { kind: 'literal', value: 'two' } }], 1));
  await assert.rejects(put(c, scope, [{ name: 'auth.password', valueType: 'string', source: { kind: 'literal', value: 'fixture only' } }], 1), { code: 'VARIABLE_INVALID' });
  await c.host.capabilities.revoke({ root: c.root, projectId: c.projectId, capability: 'document.edit' });
  await assert.rejects(put(c, scope, [], 1), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(await readFile(path), original);
});

test('A3-018: a wrong workspace override cannot invalidate another view; unbind preserves IDs and source', windows, async (t) => {
  const c = await project(t); await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  const state = await c.manager.loadProjectVariables(c.sessionId, { entityId: E1, workspaceId: W1 });
  await c.manager.bindProjectVariable(c.sessionId, E1, state.entities.find((e) => e.id === E1).revision, 'a3.display.label', { kind: 'variable', name: 'demo.name' }, { workspaceId: W1 });
  const path = join(c.root, '.a3/entities', E1 + '.json'), before = sha256(await readFile(path));
  await assert.rejects(put(c, { kind: 'workspace', ownerId: W2 }, [{ name: 'demo.name', valueType: 'number', source: { kind: 'literal', value: 42 } }]));
  assert.equal(sha256(await readFile(path)), before);
  await assert.rejects(c.manager.bindProjectVariable(c.sessionId, E1, state.entities.find((e) => e.id === E1).revision, 'a3.display.label', null), { code: 'REVISION_CONFLICT' });
  const current = await c.manager.loadProjectVariables(c.sessionId, { entityId: E1 });
  assert.equal(effective(current).ok, true);
  await c.manager.bindProjectVariable(c.sessionId, E1, current.entities.find((e) => e.id === E1).revision, 'a3.display.label', null);
  assert.equal((await c.manager.loadCanvasWorkspace(c.sessionId, W1)).entities.find((e) => e.id === E1).displayTitle, undefined);
});

test('A3-018: query execution values and bindings cannot leak into a different project session', windows, async (t) => {
  const c = await project(t); await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  await c.manager.loadProjectVariables(c.sessionId, { executionVariables: scenario.execution }); const old = c.sessionId;
  await c.manager.closeActive(old); c.sessionId = (await c.manager.openFolder(c.root)).active.sessionId;
  await assert.rejects(c.manager.loadProjectVariables(old, { executionVariables: scenario.execution }), { code: 'STALE_SESSION' });
  assert.equal(effective(await c.manager.loadProjectVariables(c.sessionId)).value.value, 'project label');
  const invalid = await c.manager.loadProjectVariables(c.sessionId, { referenceScope: { kind: 'project', ownerId: c.projectId }, executionVariables: [{ name: 'demo.bad', valueType: 'number', source: { kind: 'literal', value: 'text' } }] });
  assert.ok(invalid.executionDiagnostics.some((d) => d.detail === 'variable-type-invalid'));
});

test('A3-018/A3-019: project compiler resolves by selected workspace, marks unresolved exports, and never writes source', windows, async (t) => {
  const c = await project(t), { manager } = c;
  await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  await put(c, { kind: 'workspace', ownerId: W1 }, scenario.firstWorkspace);
  await put(c, { kind: 'workspace', ownerId: W2 }, scenario.secondWorkspace);
  const resource = JSON.parse(await readFile(join(c.root, '.a3/resources/00000000-0000-4000-8000-000000000004.json'), 'utf8'));
  const sourceFile = join(c.root, resource.path), originalSource = await readFile(sourceFile);
  const variablesFile = join(c.root, '.a3/variables/project.json'), originalVariables = await readFile(variablesFile);
  const first = await manager.resolveProjectVariableText(c.sessionId, templateCases.basic, { workspaceId: W1, entityId: E1 });
  const second = await manager.resolveProjectVariableText(c.sessionId, templateCases.basic, { workspaceId: W2, entityId: E1 });
  assert.match(first.text, /first workspace/); assert.match(second.text, /second workspace/);
  assert.equal(first.variables.find((item) => item.name === 'demo.name').scope.kind, 'workspace');
  const missing = await manager.resolveProjectVariableText(c.sessionId, templateCases.missingRequired, { workspaceId: W1, entityId: E1 }, ['demo.absent']);
  assert.equal(missing.canSendAutomatically, false); assert.match(missing.markedExport, /A3: variable sin resolver demo\.absent/);
  const ambiguous = await manager.resolveProjectVariableText(c.sessionId, '{{demo.name}}', { entityId: E1 }, ['demo.name']);
  assert.equal(ambiguous.unresolved[0].detail, 'variable-context-required');
  const templated = await manager.compileProjectPromptTemplate(c.sessionId, promptCases.validBlocks, { show: true, name: 'A3', items: ['local'] }, { workspaceId: W1, entityId: E1 });
  assert.equal(templated.canSendAutomatically, true); assert.match(templated.text, /A3/); assert.deepEqual(templated.inputsUsed, ['items', 'name', 'show']);
  assert.deepEqual(await readFile(sourceFile), originalSource); assert.deepEqual(await readFile(variablesFile), originalVariables);
});

test('A3-018/A3-019: canvas Markdown preview and deterministic SVG export use resolved copies, preserving the Markdown bytes', windows, async (t) => {
  const c = await project(t), descriptor = JSON.parse(await readFile(join(c.root, '.a3/resources/00000000-0000-4000-8000-000000000004.json'), 'utf8'));
  await c.manager.closeActive(c.sessionId); const resourcePath = join(c.root, descriptor.path), source = Buffer.from('# {{demo.name}}\n\n{{demo.absent}}');
  await writeFile(resourcePath, source); c.sessionId = (await c.manager.openFolder(c.root)).active.sessionId;
  await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  const preview = await c.manager.loadCanvasContent(c.sessionId, W1, E1, '00000000-0000-4000-8000-000000000004');
  assert.match(preview.text, /# project label/); assert.match(preview.text, /A3: variable sin resolver demo\.absent/);
  assert.equal(preview.variableDiagnostics?.length, 1); assert.deepEqual(await readFile(resourcePath), source);
  const workspace = await c.manager.loadCanvasExportWorkspaces(c.sessionId, W1, 'diagram');
  const { renderCanvasExportSvg } = await import('../dist/canvas-export.js');
  const rendered = renderCanvasExportSvg([{ ...workspace[0], resolvedContentByEntity: { [E1.toLowerCase()]: { text: preview.text } }, variableDiagnostics: preview.variableDiagnostics }],
    { scope: 'diagram', selection: { placements: [], groups: [], drawings: [], edges: [] }, background: 'opaque', margin: 8, scale: 1 });
  assert.match(rendered.svg, /project label/); assert.ok(rendered.diagnostics.some((message) => message.includes('demo.absent · variable-missing')));
  assert.deepEqual(await readFile(resourcePath), source);
});

test('A3-048: a corrupt or unknown-version variable set is diagnosed, never treated as an empty writable scope', windows, async (t) => {
  const c = await project(t); await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  const path = join(c.root, '.a3/variables/project.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  for (const bytes of [Buffer.from('{invalid json'), Buffer.from(JSON.stringify({ ...document, schemaVersion: '2.0.0' }))]) {
    await c.manager.closeActive(c.sessionId); await writeFile(path, bytes); c.sessionId = (await c.manager.openFolder(c.root)).active.sessionId;
    const read = await c.manager.loadProjectVariables(c.sessionId); assert.ok(read.blockedScopes.some((entry) => entry.scope.kind === 'project'));
    await assert.rejects(put(c, { kind: 'project', ownerId: c.projectId }, [], null), { code: 'VARIABLE_SET_READ_ONLY' });
    assert.deepEqual(await readFile(path), bytes);
  }
});

test('A3-019/A3-022: project context is explicit, reads semantic relations only, and stores hash-only local provenance', windows, async (t) => {
  const c = await project(t), resourceId = '00000000-0000-4000-8000-000000000004', relationId = '00000000-0000-4000-8000-000000000005';
  const sourcePath = join(c.root, 'pages/readme.md'), original = await readFile(sourcePath);
  await put(c, { kind: 'project', ownerId: c.projectId }, scenario.project);
  const catalog = await c.manager.loadPromptContextCatalog(c.sessionId);
  assert.equal(catalog.projectId, c.projectId); assert.equal(catalog.visualEdgeCount, 1);
  assert.deepEqual(catalog.relations.map((entry) => entry.id), [relationId]);
  const input = { mode: 'manual', source: '# Solicitud\n\n{{demo.name}}', inputs: {}, requiredNames: ['demo.name'], query: {},
    selection: { entities: [{ entityId: E1, role: 'requirement' }], resourceIds: [resourceId], relationIds: [relationId], excludedSourceKeys: [] }, maxBytes: 16 * 1024, split: false };
  const result = await c.manager.compileProjectPromptContext(c.sessionId, input);
  assert.equal(result.projectId, c.projectId); assert.equal(result.visualEdgesIncluded, 0); assert.equal(result.traceSaved, true);
  assert.match(result.parts[0].markdown, /Visión/); assert.match(result.parts[0].markdown, /Visión del fixture/); assert.match(result.parts[0].markdown, /a3\.core\.references/);
  assert.ok(result.included.some((entry) => entry.kind === 'entity' && entry.category === 'requirement' && entry.sourceHash));
  const resource = result.included.find((entry) => entry.kind === 'resource');
  assert.equal(resource.originPath, 'pages/readme.md'); assert.equal(resource.sourceHash, sha256(original)); assert.ok(resource.descriptorHash);
  assert.deepEqual(await readFile(sourcePath), original);
  const trace = JSON.parse(await readFile(join(c.root, result.tracePath), 'utf8'));
  assert.equal(trace.id, result.executionId); assert.equal(trace.projectId, c.projectId); assert.equal(trace.provider, null); assert.equal(trace.model, null);
  assert.deepEqual(trace.variableContext.requiredNames, ['demo.name']); assert.ok(trace.variables.some((variable) => variable.name === 'demo.name' && variable.valueHash));
  assert.equal(trace.included.find((entry) => entry.kind === 'resource').sourceHash, resource.sourceHash);
  assert.equal(JSON.stringify(trace).includes('Visión del fixture'), false, 'local trace must not copy source content');
  await assert.rejects(c.manager.compileProjectPromptContext(c.sessionId, { ...input, selection: { ...input.selection, relationIds: ['00000000-0000-4000-8000-000000000011'] } }),
    { code: 'PROMPT_CONTEXT_RELATION_MISSING' });
});

test('A3-019: explicit exclusion is recorded and project B cannot inherit project A prompt sources', windows, async (t) => {
  const a = await project(t), resourceId = '00000000-0000-4000-8000-000000000004', sourceA = join(a.root, 'pages/readme.md');
  await writeFile(sourceA, '# Project A exclusive context\n');
  const excluded = await a.manager.compileProjectPromptContext(a.sessionId, { mode: 'manual', source: 'Prompt A', inputs: {}, requiredNames: [], query: {},
    selection: { entities: [], resourceIds: [resourceId], relationIds: [], excludedSourceKeys: [`resource:${resourceId}`] }, maxBytes: 16 * 1024, split: false });
  assert.equal(excluded.included.length, 0); assert.equal(excluded.omitted[0].reason, 'user-excluded');
  await a.manager.closeActive(a.sessionId);

  const { root: rootB, tempRoot } = await scratch(t), manifestPath = join(rootB, 'a3.project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.projectId = '00000000-0000-4000-8000-000000000099'; await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const sourceB = join(rootB, 'pages/readme.md'); await writeFile(sourceB, '# Project B context only\n');
  const hostB = await fixtureHost(rootB, 'context-isolation-b'), managerB = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog-b'), host: hostB }); t.after(() => managerB.dispose());
  const sessionB = (await managerB.openFolder(rootB)).active.sessionId;
  const resultB = await managerB.compileProjectPromptContext(sessionB, { mode: 'manual', source: 'Prompt B', inputs: {}, requiredNames: [], query: {},
    selection: { entities: [], resourceIds: [resourceId], relationIds: [], excludedSourceKeys: [] }, maxBytes: 16 * 1024, split: false });
  assert.equal(resultB.projectId, hostB.projectId); assert.match(resultB.parts[0].markdown, /Project B context only/);
  assert.doesNotMatch(resultB.parts[0].markdown, /Project A exclusive context/);
});

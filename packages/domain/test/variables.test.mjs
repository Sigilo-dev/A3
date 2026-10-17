import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { defaultRegistry, resolveEffectiveVariable, resolveEntityField, resolveVariableText, findNodeType, validateSnapshot } from '../dist/src/index.js';
import { fixture, variableSet, find, literal, E1, W1, W2, R1, id, run, success, rejection, context } from './fixture.mjs';
const scenario = JSON.parse(await readFile(new URL('../../../fixtures/e4/variables/scenario.json', import.meta.url), 'utf8'));
const templateCases = JSON.parse(await readFile(new URL('../../../fixtures/e4/variables/template-cases.json', import.meta.url), 'utf8'));
function state() { const s = fixture(), projectId = s.records.find((r) => r.kind === 'project').value.projectId;
  const record = variableSet({ kind: 'project', ownerId: projectId }, structuredClone(scenario.project)); record.value.schemaVersion = '1.1.0';
  s.records.push(record); return { s, projectId }; }

test('A3-018: six typed variable forms, stable ID references and unknown metadata survive domain commands', () => {
  const { s, projectId } = state(); assert.deepEqual(validateSnapshot(s, defaultRegistry()).filter((d) => d.severity === 'error'), []);
  s.records.find((r) => r.kind === 'variable-set').value.variables.find((v) => v.name === 'demo.ports').items['future.item'] = { keep: true };
  for (const variable of scenario.project) { const resolved = resolveEffectiveVariable(s, variable.name); assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics)); assert.deepEqual(resolved.value.value, variable.source.value); assert.equal(resolved.value.scope.kind, 'project'); }
  const renamed = success(run(s, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'renamed' })).nextSnapshot;
  assert.equal(resolveEffectiveVariable(renamed, 'demo.entity').value.value.id, E1);
  const updated = success(run(s, 'a3.core.set-variables', { scope: { kind: 'project', ownerId: projectId }, variables: scenario.project.map((v) => v.name === 'demo.name' ? { ...v, source: { kind: 'literal', value: 'new label' } } : v) })).nextSnapshot;
  assert.deepEqual(updated.records.find((r) => r.kind === 'variable-set').value.variables[0].future, { keep: true });
  assert.deepEqual(updated.records.find((r) => r.kind === 'variable-set').value.variables.find((v) => v.name === 'demo.ports').items['future.item'], { keep: true });
  assert.deepEqual(updated.records.filter((r) => r.kind === 'entity' || r.kind === 'resource'), s.records.filter((r) => r.kind === 'entity' || r.kind === 'resource'));
});
test('A3-018/A3-004: precedence, two workspace views and explicit scopes never persist execution overrides', () => {
  const { s, projectId } = state(); s.records.push(variableSet({ kind: 'workspace', ownerId: W1 }, scenario.firstWorkspace), variableSet({ kind: 'workspace', ownerId: W2 }, scenario.secondWorkspace));
  const definition = findNodeType(defaultRegistry(), find(s, 'entity', E1).value); assert.ok(definition);
  const bound = structuredClone(success(run(s, 'a3.variables.bind-field', { entityId: E1, field: 'a3.display.label', binding: { kind: 'variable', name: 'demo.name' } })).nextSnapshot);
  const entity = find(bound, 'entity', E1).value;
  assert.equal(resolveEntityField(bound, definition, entity, 'a3.display.label', { workspaceId: W1 }).value.value, 'first workspace');
  assert.equal(resolveEntityField(bound, definition, entity, 'a3.display.label', { workspaceId: W2 }).value.value, 'second workspace');
  assert.equal(resolveEffectiveVariable(bound, 'demo.name', { entityId: E1 }).diagnostics[0].detail, 'variable-context-required');
  assert.equal(resolveEffectiveVariable(bound, 'demo.name', { entityId: E1 }, { kind: 'project', ownerId: projectId }).value.value, 'project label');
  bound.records.push(variableSet({ kind: 'entity', ownerId: E1 }, scenario.entity)); const before = structuredClone(bound);
  assert.equal(resolveEffectiveVariable(bound, 'demo.name', { workspaceId: W2, entityId: E1 }).value.scope.kind, 'entity');
  const execution = resolveEffectiveVariable(bound, 'demo.name', { workspaceId: W2, entityId: E1, executionVariables: scenario.execution });
  assert.equal(execution.value.scope.kind, 'execution'); assert.equal(execution.value.value, 'temporary execution'); assert.deepEqual(bound, before);
});
test('A3-018: aliases use qualified scope identities, missing names and cycles produce diagnostics', () => {
  const { s, projectId } = state(); const entitySet = variableSet({ kind: 'entity', ownerId: E1 }, [{ name: 'demo.name', valueType: 'string', source: { kind: 'reference', name: 'demo.name', scope: { kind: 'project', ownerId: projectId } } }]); entitySet.value.schemaVersion = '1.1.0'; s.records.push(entitySet);
  const resolved = resolveEffectiveVariable(s, 'demo.name', { entityId: E1 }); assert.equal(resolved.ok, true); assert.equal(resolved.value.dependencies[0].scope.kind, 'project');
  assert.equal(resolveEffectiveVariable(s, 'demo.absent').ok, false);
  const vars = [{ name: 'demo.a', valueType: 'string', source: { kind: 'reference', name: 'demo.b' } }, { name: 'demo.b', valueType: 'string', source: { kind: 'reference', name: 'demo.a' } }];
  rejection(run(s, 'a3.core.set-variables', { scope: { kind: 'project', ownerId: projectId }, variables: vars }), 'variable-cycle');
});
test('A3-018: malformed typed values, missing ID references and credentials never produce a write plan', () => {
  const { s, projectId } = state(), scope = { kind: 'project', ownerId: projectId };
  for (const bad of [literal('demo.bad', '12', 'number'), literal('demo.bad', 1, 'boolean'), { ...literal('demo.bad', 'go', 'enum'), enumValues: ['rust'] },
    { ...literal('demo.bad', [1, '2'], 'list'), items: { valueType: 'number' } }, literal('demo.bad', { kind: 'entity', id: id(99999) }, 'reference'),
    { ...literal('demo.bad', { kind: 'resource', id: R1 }, 'reference'), referenceKinds: ['entity'] }]) rejection(run(s, 'a3.core.set-variables', { scope, variables: [bad] }), 'variable-type-invalid');
  for (const bad of [literal('auth.api-key', 'synthetic fixture'), { ...literal('demo.bad', 'synthetic fixture'), classification: 'credential' }]) rejection(run(s, 'a3.core.set-variables', { scope, variables: [bad] }), 'variable-credential-forbidden');
});
test('A3-018: binding is opt-in and its effective result obeys the field type/range in every view', () => {
  const { s, projectId } = state(), registry = defaultRegistry();
  registry.nodeTypes.push({ name: 'fixture.typed', version: '1.0.0', packageId: 'fixture.variables', fields: [{ name: 'fixture.count', valueType: 'number', minimum: 1, maximum: 100, required: true, acceptsBinding: true }, { name: 'fixture.fixed', valueType: 'string', required: false, acceptsBinding: false }], ports: [], bindingFields: ['fixture.count'], extensions: {} });
  const entity = find(s, 'entity', E1).value; entity.type = 'fixture.typed'; entity.properties['fixture.count'] = 5;
  const payload = { entityId: E1, field: 'fixture.count', binding: { kind: 'variable', name: 'demo.count' } };
  const bound = success(run(s, 'a3.variables.bind-field', payload, [], context({ registry }))).nextSnapshot;
  const vars = scenario.project.map((v) => v.name === 'demo.count' ? { ...v, source: { kind: 'literal', value: 150 } } : v);
  rejection(run(bound, 'a3.core.set-variables', { scope: { kind: 'project', ownerId: projectId }, variables: vars }, [], context({ registry })), 'node-field-invalid');
  rejection(run(s, 'a3.variables.bind-field', { ...payload, field: 'fixture.fixed' }, [], context({ registry })), 'node-binding-forbidden');
  rejection(run(s, 'a3.variables.bind-field', { ...payload, field: 'id' }, [], context({ registry })), 'node-binding-forbidden');
  success(run(bound, 'a3.variables.bind-field', { ...payload, binding: null }, [], context({ registry })));
});
test('E4 format: E1 source.scope stays opaque until an explicit 1.1 edit; removing an explicit scope restores contextual precedence', () => {
  const s = fixture(), projectId = s.records.find((r) => r.kind === 'project').value.projectId;
  const legacy = variableSet({ kind: 'project', ownerId: projectId }, [literal('demo.name', 'legacy'), { name: 'demo.alias', valueType: 'string', source: { kind: 'reference', name: 'demo.name', scope: { future: 'opaque' } } }]);
  s.records.push(legacy); const before = structuredClone(s);
  assert.equal(resolveEffectiveVariable(s, 'demo.alias').value.value, 'legacy'); assert.deepEqual(s, before);
  rejection(run(s, 'a3.core.set-variables', { scope: legacy.value.scope, variables: [literal('demo.name', 'legacy'), { name: 'demo.alias', valueType: 'string', source: { kind: 'reference', name: 'demo.name' } }] }), 'variable-legacy-scope-review');
  const vars = [literal('demo.name', 'new'), { name: 'demo.alias', valueType: 'string', source: { kind: 'reference', name: 'demo.name', scope: { kind: 'project', ownerId: projectId } } }];
  const updated = success(run(s, 'a3.core.set-variables', { scope: legacy.value.scope, variables: vars })).nextSnapshot;
  assert.equal(updated.records.find((r) => r.kind === 'variable-set').value.schemaVersion, '1.1.0');
  const removed = success(run(updated, 'a3.core.set-variables', { scope: legacy.value.scope, variables: [vars[0], { ...vars[1], source: { kind: 'reference', name: 'demo.name' } }] })).nextSnapshot;
  assert.equal(removed.records.find((r) => r.kind === 'variable-set').value.variables[1].source.scope, undefined);
});
test('future variable documents cannot be interpreted by the pure resolver', () => {
  const { s } = state(); s.records.find((r) => r.kind === 'variable-set').value.schemaVersion = '2.0.0';
  assert.equal(resolveEffectiveVariable(s, 'demo.name').diagnostics[0].detail, 'variable-version-unsupported');
});

test('A3-018/A3-019: template resolution is a derived view with scope provenance and structured values', () => {
  const { s } = state(), source = templateCases.basic, before = structuredClone(s);
  const result = resolveVariableText(s, source);
  assert.equal(result.text, '# project label\nBackend: rust · enabled=true · ports=[80,443]');
  assert.equal(result.canSendAutomatically, true); assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.variables.map((item) => item.name), ['demo.name', 'demo.backend', 'demo.enabled', 'demo.ports']);
  assert.ok(result.variables.every((item) => item.scope.kind === 'project')); assert.deepEqual(s, before);
});

test('A3-018/A3-019: nested text variables resolve without changing their source and detect interpolation cycles', () => {
  const { s, projectId } = state(), record = find(s, 'variable-set', projectId);
  record.value.variables.push({ name: 'demo.greeting', valueType: 'string', source: { kind: 'literal', value: 'Hola, {{demo.name}}' } },
    { name: 'demo.loop', valueType: 'string', source: { kind: 'literal', value: '{{demo.loop}}' } });
  record.value.schemaVersion = '1.1.0'; const before = structuredClone(s);
  const nested = resolveVariableText(s, templateCases.nested);
  assert.equal(nested.text, 'Hola, project label'); assert.deepEqual(nested.variables.map((item) => item.name), ['demo.greeting', 'demo.name']);
  const cycle = resolveVariableText(s, templateCases.cycle, {}, ['demo.loop']);
  assert.match(cycle.text, /ciclo de variable demo\.loop/); assert.equal(cycle.canSendAutomatically, false);
  assert.equal(cycle.unresolved[0].detail, 'variable-cycle'); assert.deepEqual(s, before);
});

test('A3-018/A3-019: required unresolved references block automatic sending while export includes diagnostics', () => {
  const { s } = state(), before = structuredClone(s), result = resolveVariableText(s, templateCases.missingRequired, {}, ['demo.absent']);
  assert.equal(result.canSendAutomatically, false); assert.equal(result.unresolved[0].detail, 'variable-missing');
  assert.match(result.markedExport, /exportación con variables sin resolver/); assert.match(result.markedExport, /A3: variable sin resolver demo\.absent/);
  assert.equal(result.unresolved[0].line, 1); assert.ok(result.unresolved[0].column > 1); assert.deepEqual(s, before);
});

test('A3-018: malformed token and ambiguous entity context are diagnosed and visibly marked', () => {
  const { s } = state(); s.records.push(variableSet({ kind: 'workspace', ownerId: W1 }, scenario.firstWorkspace), variableSet({ kind: 'workspace', ownerId: W2 }, scenario.secondWorkspace));
  const malformed = resolveVariableText(s, templateCases.malformed);
  assert.equal(malformed.unresolved[0].detail, 'variable-template-syntax-invalid'); assert.equal(malformed.canSendAutomatically, false);
  const ambiguous = resolveVariableText(s, '{{demo.name}}', { entityId: E1 }, ['demo.name']);
  assert.equal(ambiguous.unresolved[0].detail, 'variable-context-required'); assert.equal(ambiguous.canSendAutomatically, false);
});

test('A3-018/A3-019: compiler reports alias cycles and invalid declarations; optional missing values stay marked', () => {
  const { s, projectId } = state(), record = find(s, 'variable-set', projectId);
  record.value.variables.push({ name: 'demo.a', valueType: 'string', source: { kind: 'reference', name: 'demo.b' } },
    { name: 'demo.b', valueType: 'string', source: { kind: 'reference', name: 'demo.a' } });
  const aliasCycle = resolveVariableText(s, '{{demo.a}}', {}, ['demo.a']); assert.equal(aliasCycle.unresolved[0].detail, 'variable-cycle');
  const optional = resolveVariableText(s, '{{demo.optional}}'); assert.equal(optional.canSendAutomatically, true); assert.match(optional.markedExport, /variable sin resolver demo\.optional/);
  const invalid = structuredClone(s); find(invalid, 'variable-set', projectId).value.variables.find((item) => item.name === 'demo.name').source.value = 9;
  const invalidValue = resolveVariableText(invalid, '{{demo.name}}', {}, ['demo.name']);
  assert.equal(invalidValue.unresolved[0].detail, 'variable-type-invalid'); assert.equal(invalidValue.canSendAutomatically, false);
});

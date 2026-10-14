import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { prepareCommand, validateSnapshot, validateRecord, validateDefinition, defaultRegistry, resolveVariable, revalidatePlan } from '../dist/src/index.js';
import { fixture, context, id, W1, W2, E1, E2, P1, P3, REL, R1, find, group, collection, variableSet, literal, freshDocument, refOf, request, run, success, rejection } from './fixture.mjs';

test('E0-A fixtures validate as canonical documents and separately resolve graph references', () => {
  const state = fixture();
  assert.ok(state.records.every((r) => validateRecord(r).length === 0));
  const diagnostics = validateSnapshot(state, defaultRegistry());
  assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0);
  assert.ok(diagnostics.some((d) => d.detail === 'node-type-unavailable'));
});
for (const [name, kind, recordId, mutate, detail] of [
  ['missing resource', 'entity', E1, (v) => { v.contentResourceId = id(700); }, 'resource-missing'],
  ['missing endpoint', 'relation', REL, (v) => { v.target.entityId = id(700); }, 'relation-entity-missing'],
  ['missing port', 'relation', REL, (v) => { v.source.portId = 'absent'; }, 'port-missing'],
  ['cross-workspace edge', 'visual-edge', '00000000-0000-4000-8000-000000000011', (v) => { v.targetPlacementId = P3; }, 'placement-not-local'],
  ['mismatched semantic view', 'relation-view', '00000000-0000-4000-8000-000000000012', (v) => { [v.sourcePlacementId, v.targetPlacementId] = [v.targetPlacementId, v.sourcePlacementId]; }, 'relation-view-endpoints']
]) test(`structural validity does not hide ${name}`, () => {
  const state = fixture(); const record = find(state, kind, recordId); mutate(record.value);
  assert.deepEqual(validateRecord(record), []);
  assert.ok(validateSnapshot(state, defaultRegistry()).some((d) => d.detail === detail));
});
test('degraded references remain intact while a valid unrelated document can be renamed', () => {
  const state = fixture(); find(state, 'relation', REL).value.target.entityId = id(700);
  const original = structuredClone(find(state, 'relation', REL));
  const plan = success(run(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Nuevo' }));
  assert.deepEqual(find(plan.nextSnapshot, 'relation', REL), original);
  assert.ok(validateSnapshot(plan.nextSnapshot, defaultRegistry()).some((d) => d.detail === 'relation-entity-missing'));
});
test('UUID collisions are rejected globally; group IDs are scoped to their workspace', () => {
  const state = fixture(); state.records.push(group(41), group(41, [], W2));
  assert.equal(validateSnapshot(state, defaultRegistry()).filter((d) => d.severity === 'error').length, 0);
  const collision = { kind: 'entity', value: { ...find(state, 'entity', E2).value, id: W1 } };
  rejection(run(state, 'a3.core.create-document', { record: collision }, [refOf(collision)]), 'duplicate-id');
  state.records.push({ kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(255) } });
  const caseCollision = { kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(255).toUpperCase() } };
  rejection(run(state, 'a3.core.create-document', { record: caseCollision }), 'record-exists');
});
test('resource location union, portable paths, safe revisions and finite geometry are checked', () => {
  const state = fixture(); const original = find(state, 'resource', R1);
  for (const value of [{ ...original.value, url: 'https://example.com' }, { ...original.value, path: '../escape.md' },
    { ...original.value, kind: 'mounted-file' }, { ...original.value, revision: 0 }, { ...original.value, schemaVersion: '2.0.0' }]) {
    assert.ok(validateRecord({ kind: 'resource', value }).length);
  }
  const cmd = request(state, 'a3.core.move-placement', { ref: { kind: 'placement', id: P1, workspaceId: W1 }, position: { x: NaN, y: 5 } });
  rejection(prepareCommand(state, cmd, context()), 'invalid-command');
});
function graphWithRules() {
  const state = fixture(); const entity = find(state, 'entity', E2).value;
  state.records.push({ kind: 'entity', value: { ...entity, id: id(20), type: 'demo.source', ports: [{ id: 'out' }] } },
    ...[21, 22].map((n) => ({ kind: 'entity', value: { ...entity, id: id(n), type: 'demo.target', ports: [{ id: 'in' }] } })));
  const registry = defaultRegistry();
  registry.nodeTypes = [
    { name: 'demo.source', version: '1.0.0', packageId: 'demo.pack', fields: [], ports: [{ id: 'out', direction: 'output' }], bindingFields: [], extensions: {} },
    { name: 'demo.target', version: '1.0.0', packageId: 'demo.pack', fields: [], ports: [{ id: 'in', direction: 'input' }], bindingFields: [], extensions: {} }
  ];
  registry.relationTypes.push({ name: 'demo.link', version: '1.0.0', direction: 'directed', allowSelf: false,
    source: { entityTypes: ['demo.source'], requirePort: true, portDirections: ['output', 'inout'], cardinality: { min: 0, max: 1 } },
    target: { entityTypes: ['demo.target'], requirePort: true, portDirections: ['input', 'inout'], cardinality: { min: 0, max: 2 } }, extensions: {} });
  const relation = { kind: 'relation', value: freshDocument(30, { type: 'demo.link', typeVersion: '1.0.0', properties: {}, source: { entityId: id(20), portId: 'out' }, target: { entityId: id(21), portId: 'in' } }) };
  return { state, registry, relation };
}
test('declared endpoint types, ports and directions validate actual semantic relations', () => {
  const { state, registry, relation } = graphWithRules(); const ctx = context({ registry });
  success(run(state, 'a3.core.create-document', { record: relation }, [refOf(relation)], ctx));
  const wrongType = structuredClone(relation); wrongType.value.target.entityId = E2;
  rejection(run(state, 'a3.core.create-document', { record: wrongType }, [refOf(wrongType)], ctx), 'endpoint-type-invalid');
  const wrongPort = structuredClone(relation); wrongPort.value.source.portId = 'absent';
  rejection(run(state, 'a3.core.create-document', { record: wrongPort }, [refOf(wrongPort)], ctx), 'port-missing');
  const wrongDirection = structuredClone(registry); wrongDirection.nodeTypes[0].ports[0].direction = 'input';
  rejection(run(state, 'a3.core.create-document', { record: relation }, [refOf(relation)], context({ registry: wrongDirection })), 'port-direction-invalid');
  const noPort = structuredClone(relation); delete noPort.value.source.portId;
  rejection(run(state, 'a3.core.create-document', { record: noPort }, [refOf(noPort)], ctx), 'endpoint-port-required');
});
test('maximum cardinality is enforced; incomplete minimum is diagnosed during editing', () => {
  const { state, registry, relation } = graphWithRules(); state.records.push(relation);
  const second = structuredClone(relation); second.value.id = id(31); second.value.target.entityId = id(22);
  rejection(run(state, 'a3.core.create-document', { record: second }, [refOf(second)], context({ registry })), 'cardinality-max');
  const incomplete = graphWithRules(); incomplete.registry.relationTypes[1].source.cardinality.min = 1;
  assert.ok(validateSnapshot(incomplete.state, incomplete.registry).some((d) => d.detail === 'cardinality-incomplete' && d.severity === 'warning'));
});
test('undirected cardinality counts incidence on both roles and ignores opaque rule metadata', () => {
  const state = fixture(); const registry = defaultRegistry();
  const rule = { entityTypes: '*', requirePort: false, cardinality: { min: 0, max: 1 } };
  registry.relationTypes.push({ name: 'demo.symmetric', version: '1.0.0', direction: 'undirected', allowSelf: false, source: rule, target: structuredClone(rule), extensions: {} });
  registry.relationTypes[1].source.entityTypes = ['a3.core.page', 'a3.core.concept'];
  registry.relationTypes[1].target.entityTypes = ['a3.core.concept', 'a3.core.page'];
  registry.relationTypes[1].source.future = 'opaque';
  assert.deepEqual(validateDefinition('relation-type', registry.relationTypes[1]), []);
  const edge = (n, source, target) => ({ kind: 'relation', value: freshDocument(n, { type: 'demo.symmetric', typeVersion: '1.0.0', source: { entityId: source }, target: { entityId: target }, properties: {} }) });
  state.records.push({ kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(40) } }, edge(41, E1, E2));
  const second = edge(42, E2, id(40));
  rejection(run(state, 'a3.core.create-document', { record: second }, [refOf(second)], context({ registry })), 'cardinality-max');
});
test('unknown C4/UML/IoT rules preserve imported content but cannot authorize new links', () => {
  const state = fixture(); const relation = structuredClone(find(state, 'relation', REL));
  relation.value.type = 'demo.iot'; relation.value.id = id(40);
  rejection(run(state, 'a3.core.create-document', { record: relation }, [refOf(relation)]), 'relation-rule-unavailable');
  state.records.push(relation);
  const result = run(state, 'a3.core.rename', { ref: { kind: 'workspace', id: W1 }, name: 'Plano' });
  const plan = success(result);
  assert.deepEqual(find(plan.nextSnapshot, 'relation', id(40)), relation);
  assert.ok(result.diagnostics.some((d) => d.detail === 'relation-rule-unavailable'));
});
test('node types are immutable per version; unregistering preserves entities for fallback', () => {
  const state = fixture(); const definition = { name: 'a3.core.page', version: '1.0.0', packageId: 'a3.core', fields: [], ports: [], bindingFields: [], extensions: {}, future: { inert: true } };
  const plan = success(run(state, 'a3.core.register-node-type', { definition }));
  assert.equal(plan.changes.length, 0); assert.deepEqual(plan.nextSnapshot, state);
  assert.deepEqual(plan.nextRegistry.nodeTypes[0].future, { inert: true });
  const ctx = context({ registry: plan.nextRegistry });
  rejection(run(state, 'a3.core.register-node-type', { definition: { ...definition, fields: [{ name: 'demo.required', valueType: 'number', required: true }] } }, [], ctx), 'type-version-exists');
  const removal = run(state, 'a3.core.unregister-node-type', { name: definition.name, version: definition.version }, [], ctx);
  const removed = success(removal);
  assert.deepEqual(removed.nextSnapshot, state);
  assert.ok(removal.diagnostics.some((d) => d.detail === 'node-type-unavailable'));
  rejection(revalidatePlan(plan, state, context({ registry: plan.nextRegistry })), 'snapshot-conflict');
});
test('declared field types constrain new entities while unknown properties remain opaque', () => {
  const state = fixture(); const registry = defaultRegistry();
  registry.nodeTypes.push({ name: 'demo.node', version: '1.0.0', packageId: 'demo.pack', fields: [{ name: 'demo.count', valueType: 'number', required: true }], ports: [], bindingFields: [], extensions: {} });
  const record = { kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(40), type: 'demo.node', properties: { 'demo.count': 'bad', 'future.field': { keep: true } } } };
  rejection(run(state, 'a3.core.create-document', { record }, [refOf(record)], context({ registry })), 'node-field-invalid');
  record.value.properties['demo.count'] = 42;
  const plan = success(run(state, 'a3.core.create-document', { record }, [refOf(record)], context({ registry })));
  assert.deepEqual(find(plan.nextSnapshot, 'entity', id(40)).value.properties['future.field'], { keep: true });
});
test('spatial groups and logical collections do not share membership or delete content', () => {
  const state = fixture(); const spatial = group(40, [{ kind: 'placement', id: P3 }]);
  rejection(run(state, 'a3.core.create-document', { record: spatial }, [refOf(spatial)]), 'group-member-missing');
  const logical = collection(41, [E1, E2]);
  const plan = success(run(state, 'a3.core.create-document', { record: logical }, [refOf(logical)]));
  const current = structuredClone(plan.nextSnapshot); current.records.push(group(42, [{ kind: 'placement', id: P1 }]));
  const removed = success(run(current, 'a3.core.delete', { ref: { kind: 'group', id: id(42), workspaceId: W1 } }));
  assert.deepEqual(find(removed.nextSnapshot, 'collection', id(41)), logical); assert.ok(find(removed.nextSnapshot, 'placement', P1));
});
test('variable precedence uses explicit workspace; execution values never persist', () => {
  const state = fixture(); const projectId = state.records.find((r) => r.kind === 'project').value.projectId;
  state.records.push(variableSet({ kind: 'project', ownerId: projectId }, [literal('demo.name', 'project')]),
    variableSet({ kind: 'workspace', ownerId: W1 }, [literal('demo.name', 'first')]),
    variableSet({ kind: 'workspace', ownerId: W2 }, [literal('demo.name', 'second')]),
    variableSet({ kind: 'entity', ownerId: E1 }, [literal('demo.name', 'entity')]));
  assert.equal(resolveVariable(state, 'demo.name').value, 'project');
  assert.equal(resolveVariable(state, 'demo.name', { workspaceId: W2 }).value, 'second');
  assert.equal(resolveVariable(state, 'demo.name', { workspaceId: W1, entityId: E1 }).value, 'entity');
  const before = structuredClone(state);
  assert.equal(resolveVariable(state, 'demo.name', { entityId: E1, executionVariables: [literal('demo.name', 'execution')] }).value, 'execution');
  assert.deepEqual(state, before);
});
test('cycles, missing variables, type mismatches and duplicate execution variables are diagnosed', () => {
  const state = fixture(); const scope = { kind: 'entity', ownerId: E1 };
  const reference = (name, target) => ({ name, valueType: 'string', source: { kind: 'reference', name: target } });
  rejection(run(state, 'a3.core.set-variables', { scope, variables: [reference('demo.a', 'demo.b'), reference('demo.b', 'demo.a')] }, [{ kind: 'variable-set', id: E1, variableScope: 'entity' }]), 'variable-cycle');
  rejection(run(state, 'a3.core.set-variables', { scope, variables: [literal('demo.bad', 'text', 'number')] }, [{ kind: 'variable-set', id: E1, variableScope: 'entity' }]), 'variable-type-invalid');
  assert.equal(resolveVariable(state, 'demo.absent').ok, false);
  assert.equal(resolveVariable(state, 'demo.same', { executionVariables: [literal('demo.same', 'a'), literal('demo.same', 'b')] }).ok, false);
});
test('variable updates preserve container and unknown nested source fields', () => {
  const state = fixture(); const scope = { kind: 'entity', ownerId: E1 };
  const original = variableSet(scope, [{ ...literal('demo.name', 'old'), future: true, source: { kind: 'literal', value: 'old', futureSource: { keep: true } } }]);
  original.value.extensions['future.keep'] = ['data']; state.records.push(original);
  const plan = success(run(state, 'a3.core.set-variables', { scope, variables: [literal('demo.name', 'new')] }));
  const next = plan.nextSnapshot.records.find((r) => r.kind === 'variable-set');
  assert.deepEqual(next.value.extensions, original.value.extensions); assert.equal(next.value.variables[0].future, true);
  assert.deepEqual(next.value.variables[0].source.futureSource, { keep: true }); assert.equal(next.value.revision, 2);
});
test('permission revocation invalidates an otherwise current prepared plan', () => {
  const state = fixture(); const plan = success(run(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Changed' }));
  rejection(revalidatePlan(plan, state, context({ authorization: { authorize: () => false } })), 'permission-denied');
});
test('accessors cannot execute code; prototype-shaped unknown keys survive without changing prototypes', () => {
  const state = fixture(); let executed = false; const payload = {};
  Object.defineProperty(payload, 'title', { enumerable: true, get() { executed = true; return 'bad'; } });
  rejection(run(state, 'a3.core.update-entity', payload), 'invalid-command'); assert.equal(executed, false);
  const page = find(state, 'entity', E1).value;
  Object.defineProperty(page, '__proto__', { value: { keep: 'opaque' }, writable: true, enumerable: true, configurable: true });
  const plan = success(run(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Changed' }));
  assert.equal(Object.getPrototypeOf(find(plan.nextSnapshot, 'entity', E1).value), Object.prototype);
  assert.deepEqual(find(plan.nextSnapshot, 'entity', E1).value.__proto__, { keep: 'opaque' });
});
test('domain source has no IO, framework, random identity or clock imports', () => {
  for (const name of readdirSync(new URL('../src/', import.meta.url)).filter((v) => v.endsWith('.ts'))) {
    const source = readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:|electron|react|@xyflow)|\b(?:Math\.random|Date\.now|fetch|localStorage)\s*\(/, name);
  }
});

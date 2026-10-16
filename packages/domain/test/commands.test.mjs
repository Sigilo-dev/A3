import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCommand, revalidatePlan, getRecord, resolveVariable } from '../dist/src/index.js';
import { fixture, context, id, W1, W2, E1, E2, R1, P1, P2, P3, REL, hash, find, group, collection, variableSet, literal, freshDocument, refOf, request, run, success, rejection, duplicatePayload } from './fixture.mjs';

test('workspace camera command preserves opaque data, identities and all geometry outside its own viewport', () => {
  const state = fixture(); find(state, 'workspace', W1).value.viewport.futureCamera = { keep: true };
  const viewport = { x: -1e12 + 0.125, y: 1e12 - 0.25, zoom: 0.05 };
  const result = success(run(state, 'a3.core.set-workspace-viewport', { workspaceId: W1, viewport }));
  assert.deepEqual(find(result.nextSnapshot, 'workspace', W1).value.viewport, { ...viewport, futureCamera: { keep: true } });
  assert.equal(result.changes.length, 1); assert.equal(result.changes[0].ref.kind, 'workspace');
  assert.deepEqual(find(result.nextSnapshot, 'workspace', W2), find(state, 'workspace', W2));
  assert.deepEqual(find(result.nextSnapshot, 'placement', P1, W1), find(state, 'placement', P1, W1));
  rejection(run(state, 'a3.core.set-workspace-viewport', { workspaceId: W1, viewport: { x: 0, y: 0, zoom: 0 } }), 'invalid-viewport');
  rejection(run(state, 'a3.core.set-workspace-viewport', { workspaceId: W1, viewport: { ...viewport, id: E1 } }), 'invalid-viewport');
});

test('A3-004: content identity is shared; moving one view does not move the other', () => {
  const state = fixture();
  const original = structuredClone(state);
  const renamed = success(run(state, 'a3.core.update-entity', { title: 'Visión revisada' }, [], context(), { scope: { entityIds: [E1] } }));
  const placements = renamed.nextSnapshot.records.filter((r) => r.kind === 'placement' && r.value.entityId === E1);
  assert.equal(placements.length, 2);
  assert.ok(placements.every((r) => getRecord(renamed.nextSnapshot, { kind: 'entity', id: r.value.entityId }).value.title === 'Visión revisada'));
  assert.equal(find(renamed.nextSnapshot, 'entity', E1).value.contentResourceId, R1);
  const moved = success(run(renamed.nextSnapshot, 'a3.core.move-placement', { ref: { kind: 'placement', id: P1, workspaceId: W1 }, position: { x: 900, y: 300 } }));
  assert.deepEqual(find(moved.nextSnapshot, 'placement', P3, W2).value, find(state, 'placement', P3, W2).value);
  assert.equal(find(moved.nextSnapshot, 'entity', E1).value.revision, 2);
  assert.equal(find(moved.nextSnapshot, 'placement', P1, W1).value.revision, 2);
  assert.deepEqual(state, original);
});

test('rename and metadata patches preserve unknown fields, nested port data and namespaces', () => {
  const state = fixture();
  const page = find(state, 'entity', E1).value;
  page.futureField = { opaque: [null, { nested: true }] };
  page.properties['future.keep'] = { id: E2 };
  page.ports = [{ id: 'stable', label: 'Antiguo', futurePort: { keep: true } }];
  const next = success(run(state, 'a3.core.update-entity', { title: 'Nuevo', properties: { 'demo.value': 5 }, ports: [{ id: 'stable', label: 'Nuevo puerto' }] }, [], context(), { scope: { entityIds: [E1] } })).nextSnapshot;
  assert.deepEqual(find(next, 'entity', E1).value.futureField, page.futureField);
  assert.deepEqual(find(next, 'entity', E1).value.properties['future.keep'], page.properties['future.keep']);
  assert.deepEqual(find(next, 'entity', E1).value.ports[0].futurePort, { keep: true });
  assert.deepEqual(find(next, 'entity', E1).value.extensions, page.extensions);
  assert.equal(find(next, 'entity', E1).value.ports[0].id, 'stable');
});

test('revision conflict, missing write precondition and forged identity produce no plan', () => {
  const state = fixture();
  const cmd = request(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Nuevo' });
  cmd.expectedRevisions.find((r) => r.kind === 'entity' && r.id === E1).revision = 2;
  rejection(prepareCommand(state, cmd, context()), 'revision-conflict');
  cmd.expectedRevisions = [];
  rejection(prepareCommand(state, cmd, context()), 'precondition-required');
  rejection(run(state, 'a3.core.update-entity', { id: id(44) }, [], context(), { scope: { entityIds: [E1] } }), 'unsafe-entity-patch');
  const impostor = { ...cmd, actor: { kind: 'agent', id: 'impersonator' } };
  rejection(prepareCommand(state, impostor, context()), 'actor-mismatch');
  assert.equal(find(state, 'entity', E1).value.revision, 1);
});

test('host permission denial, failure and scope narrowing fail closed', () => {
  const state = fixture();
  const payload = { ref: { kind: 'placement', id: P1, workspaceId: W1 }, position: { x: 50, y: 50 } };
  rejection(run(state, 'a3.core.move-placement', payload, [], context({ authorization: { authorize: () => false } })), 'permission-denied');
  rejection(run(state, 'a3.core.move-placement', payload, [], context({ authorization: { authorize: () => { throw new Error('Unavailable'); } } })), 'permission-denied');
  rejection(run(state, 'a3.core.move-placement', payload, [], context(), { scope: { entityIds: [] } }), 'scope-exceeded');
  let actualRequest;
  success(run(state, 'a3.core.move-placement', payload, [], context({ authorization: { authorize: (value) => { if (value.refs.length) actualRequest = value; return true; } } })));
  assert.deepEqual(actualRequest.entityIds, [E1]);
  assert.ok(Object.isFrozen(actualRequest));
});

test('a new representation preserves entity and resource IDs without semantic side effects', () => {
  const state = fixture();
  const record = { kind: 'placement', workspaceId: W2, value: { ...find(state, 'placement', P1).value, id: id(80), revision: 1 } };
  const plan = success(run(state, 'a3.core.create-document', { record }, [refOf(record)]));
  assert.equal(plan.changes.length, 1);
  assert.equal(find(plan.nextSnapshot, 'placement', id(80)).value.entityId, E1);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'entity').length, 2);
  assert.equal(plan.contentEffects.length, 0);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'relation').length, 1);
});

test('placement view edits revise only that workspace representation and preserve opaque style data', () => {
  const state = fixture();
  const before = structuredClone(state);
  const plan = success(run(state, 'a3.core.update-placement-view', {
    ref: { kind: 'placement', id: P1, workspaceId: W1 },
    position: { x: 125.25, y: -88 }, size: { width: 420, height: 260 },
    style: { 'future.palette': { accent: 'sage' } }
  }, [], context()));
  const changed = find(plan.nextSnapshot, 'placement', P1, W1);
  const otherView = find(plan.nextSnapshot, 'placement', P3, W2);
  assert.equal(changed.value.revision, 2);
  assert.deepEqual(changed.value.position, { ...find(before, 'placement', P1, W1).value.position, x: 125.25, y: -88 });
  assert.deepEqual(changed.value.size, { width: 420, height: 260 });
  assert.deepEqual(changed.value.style['future.palette'], { accent: 'sage' });
  assert.deepEqual(otherView.value, find(before, 'placement', P3, W2).value);
  assert.deepEqual(find(plan.nextSnapshot, 'entity', E1).value, find(before, 'entity', E1).value);
});

test('placement view edits require a valid size and preserve existing style keys', () => {
  const state = fixture();
  rejection(run(state, 'a3.core.update-placement-view', {
    ref: { kind: 'placement', id: P1, workspaceId: W1 }, size: { width: 0, height: 120 }
  }, [], context()), 'invalid-placement-size');
  const old = find(state, 'placement', P1, W1);
  old.value.style['future.keep'] = { retained: true };
  const plan = success(run(state, 'a3.core.update-placement-view', {
    ref: { kind: 'placement', id: P1, workspaceId: W1 }, style: { 'a3.ui.accent': '#74a778' }
  }, [], context()));
  assert.deepEqual(find(plan.nextSnapshot, 'placement', P1, W1).value.style, {
    'future.keep': { retained: true }, 'a3.ui.accent': '#74a778'
  });
});

test('A3-005: duplicate content remaps internal graph and retains originals and opaque metadata', () => {
  const state = fixture();
  const before = structuredClone(state);
  const { payload, refs } = duplicatePayload(state);
  const plan = success(run(state, 'a3.core.duplicate-selection', payload, refs));
  const next = plan.nextSnapshot;
  assert.equal(find(next, 'placement', id(108)).value.entityId, id(102));
  assert.equal(find(next, 'placement', id(110)).value.entityId, id(103));
  assert.equal(find(next, 'entity', id(102)).value.contentResourceId, id(104));
  assert.equal(find(next, 'relation', id(105)).value.source.entityId, id(102));
  assert.equal(find(next, 'relation', id(105)).value.target.entityId, id(103));
  assert.equal(find(next, 'visual-edge', id(111)).value.targetPlacementId, id(110));
  assert.equal(find(next, 'relation-view', id(112)).value.relationId, id(105));
  assert.deepEqual(find(next, 'entity', id(102)).value.extensions, find(state, 'entity', E1).value.extensions);
  assert.deepEqual(plan.contentEffects, [{ kind: 'copy', sourceId: R1, targetId: id(104), expectedHash: hash }]);
  for (const old of state.records) assert.deepEqual(getRecord(next, refOf(old)), old);
  assert.deepEqual(state, before);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.nextSnapshot.records));
  assert.throws(() => { plan.nextSnapshot.records.push(state.records[0]); }, TypeError);
});

test('duplicate references copies only placements and view edges, sharing canonical content', () => {
  const state = fixture();
  const { payload, refs } = duplicatePayload(state, 'representation');
  const plan = success(run(state, 'a3.core.duplicate-selection', payload, refs));
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'entity').length, 2);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'resource').length, 1);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'relation').length, 1);
  assert.equal(find(plan.nextSnapshot, 'placement', id(108)).value.entityId, E1);
  assert.equal(find(plan.nextSnapshot, 'relation-view', id(112)).value.relationId, REL);
  assert.deepEqual(plan.contentEffects, []);
});

test('external semantic relations stay untouched by default and clone only explicitly', () => {
  const state = fixture();
  state.records.push({ kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(200) } },
    { kind: 'relation', value: { ...find(state, 'relation', REL).value, id: id(201), target: { entityId: id(200) } } });
  const { payload, refs } = duplicatePayload(state);
  let plan = success(run(state, 'a3.core.duplicate-selection', payload, refs));
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'relation').length, 3);
  assert.deepEqual(find(plan.nextSnapshot, 'relation', id(201)), find(state, 'relation', id(201)));
  payload.includeExternalRelations = true;
  payload.ids.relations[id(201)] = id(202);
  plan = success(run(state, 'a3.core.duplicate-selection', payload, [...refs, { kind: 'relation', id: id(202) }]));
  assert.equal(find(plan.nextSnapshot, 'relation', id(202)).value.source.entityId, id(102));
  assert.equal(find(plan.nextSnapshot, 'relation', id(202)).value.target.entityId, id(200));
});

test('duplicate refuses reused IDs, shared target content and stale hashes without changing input', () => {
  const state = fixture(); const before = structuredClone(state);
  const { payload, refs } = duplicatePayload(state);
  payload.ids.entities[E1] = E1;
  rejection(run(state, 'a3.core.duplicate-selection', payload, refs), 'new-id-required');
  payload.ids.entities[E1] = id(102);
  payload.resourceCopies[0].location.path = 'pages/readme.md';
  rejection(run(state, 'a3.core.duplicate-selection', payload, refs), 'independent-resource-required');
  payload.resourceCopies[0].location.path = 'pages/readme-copy.md';
  rejection(run(state, 'a3.core.duplicate-selection', payload, refs, context({ contentHashes: { [R1]: 'b'.repeat(64) } })), 'content-conflict');
  assert.deepEqual(state, before);
});

test('duplicating repeated views of one entity creates one canonical clone and one resource copy', () => {
  const state = fixture();
  state.records.push({ kind: 'placement', workspaceId: W1, value: { ...find(state, 'placement', P1).value, id: id(81) } });
  const payload = { workspaceId: W1, placementIds: [P1, id(81)], mode: 'content', offset: { x: 0, y: 0 }, includeExternalRelations: false,
    ids: { entities: { [E1]: id(102) }, placements: { [P1]: id(108), [id(81)]: id(180) }, relations: {}, visualEdges: {}, relationViews: {} },
    resourceCopies: [{ sourceId: R1, id: id(104), location: { kind: 'project-file', path: 'pages/readme-copy.md' } }] };
  const refs = [{ kind: 'entity', id: id(102) }, { kind: 'resource', id: id(104) }, ...[108, 180].map((n) => ({ kind: 'placement', id: id(n), workspaceId: W1 }))];
  const plan = success(run(state, 'a3.core.duplicate-selection', payload, refs));
  assert.equal(plan.contentEffects.length, 1);
  assert.equal(find(plan.nextSnapshot, 'placement', id(180)).value.entityId, id(102));
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'entity').length, 3);
});

test('UUID aliases cannot silently select one of two duplicate ID mappings', () => {
  const state = fixture(); const { payload, refs } = duplicatePayload(state);
  state.records.push({ kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(255) } },
    { kind: 'placement', workspaceId: W1, value: { ...find(state, 'placement', P1).value, id: id(256), entityId: id(255) } });
  payload.placementIds.push(id(256));
  payload.ids.entities[id(255)] = id(257);
  payload.ids.entities[id(255).toUpperCase()] = id(258);
  payload.ids.placements[id(256)] = id(259);
  rejection(run(state, 'a3.core.duplicate-selection', payload, refs), 'invalid-id-map');
  assert.equal(find(state, 'entity', id(257)), undefined);
});

test('entity-scoped variables duplicate into an independent container for the new entity', () => {
  const state = fixture();
  state.records.push(variableSet({ kind: 'entity', ownerId: E1 }, [literal('demo.name', 'Page') ]));
  const { payload, refs } = duplicatePayload(state);
  const plan = success(run(state, 'a3.core.duplicate-selection', payload, [...refs, { kind: 'variable-set', id: id(102), variableScope: 'entity' }]));
  assert.equal(resolveVariable(plan.nextSnapshot, 'demo.name', { entityId: id(102) }).value, 'Page');
  assert.equal(getRecord(plan.nextSnapshot, { kind: 'variable-set', id: id(102), variableScope: 'entity' }).value.revision, 1);
});

test('remove a placement clears local view references and groups without deleting canonical data', () => {
  const state = fixture();
  state.records.push(group(40, [{ kind: 'placement', id: P1 }, { kind: 'placement', id: P2 }]));
  const plan = success(run(state, 'a3.core.delete', { ref: { kind: 'placement', id: P1, workspaceId: W1 } }));
  assert.equal(find(plan.nextSnapshot, 'placement', P1), undefined);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'visual-edge' || r.kind === 'relation-view').length, 0);
  assert.equal(find(plan.nextSnapshot, 'group', id(40)).value.members.length, 1);
  assert.deepEqual(find(plan.nextSnapshot, 'entity', E1), find(state, 'entity', E1));
  assert.deepEqual(find(plan.nextSnapshot, 'relation', REL), find(state, 'relation', REL));
  assert.deepEqual(find(plan.nextSnapshot, 'resource', R1), find(state, 'resource', R1));
});

test('entity deletion is a revision-guarded cascade across views while preserving source resource', () => {
  const state = fixture();
  state.records.push(collection(40, [E1, E2]), group(41, [{ kind: 'placement', id: P1 }]));
  const plan = success(run(state, 'a3.core.delete', { ref: { kind: 'entity', id: E1 } }));
  assert.equal(find(plan.nextSnapshot, 'entity', E1), undefined);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'placement' && r.value.entityId === E1).length, 0);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'relation' || r.kind === 'relation-view' || r.kind === 'visual-edge').length, 0);
  assert.deepEqual(find(plan.nextSnapshot, 'collection', id(40)).value.entityIds, [E2]);
  assert.equal(find(plan.nextSnapshot, 'resource', R1).value.revision, 1);
  const cmd = request(state, 'a3.core.delete', { ref: { kind: 'entity', id: E1 } });
  cmd.expectedRevisions = cmd.expectedRevisions.filter((r) => r.kind === 'entity');
  rejection(prepareCommand(state, cmd, context()), 'precondition-required');
});

test('resource removal is refused while shared; moving only returns metadata and a host effect', () => {
  const state = fixture();
  rejection(run(state, 'a3.core.delete', { ref: { kind: 'resource', id: R1 } }), 'resource-in-use');
  const plan = success(run(state, 'a3.core.move-resource', { resourceId: R1, location: { kind: 'project-file', path: 'pages/moved.md' } }));
  assert.equal(find(plan.nextSnapshot, 'resource', R1).value.path, 'pages/moved.md');
  assert.equal(find(plan.nextSnapshot, 'entity', E1).value.contentResourceId, R1);
  assert.equal(plan.contentEffects[0].kind, 'move');
  assert.equal(plan.contentEffects[0].expectedHash, hash);
  assert.equal(find(state, 'resource', R1).value.path, 'pages/readme.md');
});

test('a resource move cannot smuggle identity or revision fields into its location', () => {
  const state = fixture();
  state.records.push({ kind: 'resource', value: { ...find(state, 'resource', R1).value, id: id(40) } });
  rejection(run(state, 'a3.core.move-resource', { resourceId: id(40), location: { kind: 'project-file', path: 'pages/new.md', id: id(41), revision: 1 } }, [],
    context({ contentHashes: { [R1]: hash, [id(40)]: hash } }), { expectedContentHashes: [{ resourceId: id(40), hash }] }), 'unsafe-resource-location');
  assert.equal(find(state, 'resource', id(40)).value.id, id(40));
});

test('the permission adapter sees proposed resource locations before it grants writes', () => {
  const state = fixture(); const { payload, refs } = duplicatePayload(state);
  const ctx = context({ authorization: { authorize: (value) => value.changes.every((change) =>
    change.after?.kind !== 'resource' || change.after.value.path.startsWith('approved/')) } });
  rejection(run(state, 'a3.core.duplicate-selection', payload, refs, ctx), 'permission-denied');
  payload.resourceCopies[0].location.path = 'approved/readme-copy.md';
  const plan = success(run(state, 'a3.core.duplicate-selection', payload, refs, ctx));
  assert.equal(find(plan.nextSnapshot, 'resource', id(104)).value.path, 'approved/readme-copy.md');
});

test('deleting the default workspace needs a replacement and does not delete entities', () => {
  const state = fixture();
  rejection(run(state, 'a3.core.delete', { ref: { kind: 'workspace', id: W1 } }), 'default-workspace-required');
  const plan = success(run(state, 'a3.core.delete', { ref: { kind: 'workspace', id: W1 }, replacementDefaultWorkspaceId: W2 }));
  assert.equal(plan.nextSnapshot.records.find((r) => r.kind === 'project').value.defaultWorkspaceId, W2);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.kind === 'entity').length, 2);
  assert.equal(plan.nextSnapshot.records.filter((r) => r.workspaceId === W1).length, 0);
});

test('group cycles are rejected; moving a nested selection transforms shared members once', () => {
  const state = fixture();
  state.records.push(group(40, [{ kind: 'placement', id: P1 }]), group(41, [{ kind: 'group', id: id(40) }, { kind: 'placement', id: P1 }]));
  rejection(run(state, 'a3.core.set-group-members', { ref: { kind: 'group', id: id(40), workspaceId: W1 }, members: [{ kind: 'group', id: id(41) }] }), 'group-cycle');
  const before = find(state, 'placement', P1).value.position;
  const plan = success(run(state, 'a3.core.move-group', { ref: { kind: 'group', id: id(41), workspaceId: W1 }, offset: { x: 10, y: 20 } }));
  assert.equal(find(plan.nextSnapshot, 'placement', P1).value.position.x, before.x + 10);
  assert.equal(find(plan.nextSnapshot, 'placement', P1).value.position.y, before.y + 20);
  assert.equal(find(plan.nextSnapshot, 'placement', P1).value.revision, 2);
  const record = { kind: 'drawing', workspaceId: W1, value: freshDocument(42, { points: [{ x: 1, y: 2, pressure: 0.7 }],
    parameters: { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true }, style: {}, futureGeometry: true }) };
  state.records.push(record);
  find(state, 'group', id(40)).value.members.push({ kind: 'drawing', id: id(42) });
  const moved = success(run(state, 'a3.core.move-group', { ref: { kind: 'group', id: id(40), workspaceId: W1 }, offset: { x: 10, y: 20 } })).nextSnapshot;
  assert.deepEqual(find(moved, 'drawing', id(42), W1).value.points, [{ x: 11, y: 22, pressure: 0.7 }]);
  assert.deepEqual(find(moved, 'drawing', id(42), W1).value.parameters, find(state, 'drawing', id(42), W1).value.parameters);
  assert.equal(find(moved, 'drawing', id(42), W1).value.futureGeometry, true);
  const collapsed = success(run(moved, 'a3.core.set-group-collapsed', { ref: { kind: 'group', id: id(40), workspaceId: W1 }, collapsed: true })).nextSnapshot;
  assert.equal(find(collapsed, 'group', id(40), W1).value.collapsed, true);
});

test('creating a project validates default workspace and absence preconditions', () => {
  const source = fixture();
  const project = source.records.find((r) => r.kind === 'project').value;
  const workspace = find(source, 'workspace', W1).value;
  const empty = { records: [] };
  const cmd = request(empty, 'a3.core.create-project', { project, workspace }, [{ kind: 'project', id: project.projectId }, { kind: 'workspace', id: W1 }], { expectedContentHashes: [] });
  const plan = success(prepareCommand(empty, cmd, context({ contentHashes: {} })));
  assert.equal(plan.nextSnapshot.records.length, 2);
  assert.equal(plan.changes.every((c) => c.before === null), true);
  assert.equal(empty.records.length, 0);
});

test('prepared plans are deterministic and detect stale catalog, dependency, content and tampering', () => {
  const state = fixture();
  const cmd = request(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Nuevo' });
  const plan = success(prepareCommand(state, cmd, context()));
  assert.deepEqual(success(prepareCommand(state, cmd, context())), plan);
  success(revalidatePlan(plan, state, context()));
  const modified = structuredClone(state);
  find(modified, 'entity', E2).value.revision++;
  rejection(revalidatePlan(plan, modified, context()), 'snapshot-conflict');
  modified.records.push({ kind: 'entity', value: { ...find(state, 'entity', E2).value, id: id(301) } });
  rejection(revalidatePlan(plan, modified, context()), 'snapshot-conflict');
  rejection(revalidatePlan(plan, state, context({ contentHashes: { [R1]: 'b'.repeat(64) } })), 'snapshot-conflict');
  const forged = structuredClone(plan); find(forged.nextSnapshot, 'entity', E1).value.title = 'Tampered';
  rejection(revalidatePlan(forged, state, context()), 'plan-modified');
});

test('malformed, nonfinite and cyclic inputs or overflow cannot return partial changes', () => {
  const state = fixture();
  const cmd = request(state, 'a3.core.move-placement', { ref: { kind: 'placement', id: P1, workspaceId: W1 }, position: { x: Infinity, y: 0 } });
  rejection(prepareCommand(state, cmd, context()), 'invalid-command');
  const cyclic = {}; cyclic.self = cyclic;
  rejection(prepareCommand(state, cyclic, context()), 'invalid-command');
  find(state, 'entity', E1).value.revision = Number.MAX_SAFE_INTEGER;
  rejection(run(state, 'a3.core.rename', { ref: { kind: 'entity', id: E1 }, name: 'Nuevo' }), 'revision-overflow');
});

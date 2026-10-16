import assert from 'node:assert/strict';
import test from 'node:test';
import { reversibleCanvasCommand } from '../dist/src/index.js';
import { fixture, find, freshDocument, id, run, success, rejection, W1, W2 } from './fixture.mjs';

const parameters = { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false };
const drawingRef = { kind: 'drawing', id: id(801), workspaceId: W1 };
const drawingRecord = (overrides = {}) => ({ kind: 'drawing', workspaceId: W1, value: freshDocument(801, {
  points: [{ x: 12.125, y: -8.75, pressure: 0.3 }, { x: 14.5, y: -2.25, pressure: 0.9 }], parameters,
  style: { 'a3.ui.stroke.color': '#c3ed82', 'future.keep': { yes: true } }, ...overrides
}) });

test('A3-007: drawings persist editable points and pressure as reversible workspace changes', () => {
  const state = fixture(), createdPlan = success(run(state, 'a3.core.create-document', { record: drawingRecord() }, [drawingRef]));
  const event = reversibleCanvasCommand(createdPlan, W1);
  assert.equal(event.workspaceId, W1); assert.equal(event.command, 'a3.core.create-document');
  assert.equal(event.changes.length, 1); assert.equal(event.changes[0].before, null);
  assert.deepEqual(find(createdPlan.nextSnapshot, 'drawing', drawingRef.id, W1).value.points, drawingRecord().value.points);

  const updatedPlan = success(run(createdPlan.nextSnapshot, 'a3.core.update-drawing', { ref: drawingRef,
    points: [{ x: -100.125, y: 2500.75, pressure: 0.72 }], parameters: { size: 8 }, style: { 'a3.ui.stroke.color': '#78a9d1' } }));
  const updated = find(updatedPlan.nextSnapshot, 'drawing', drawingRef.id, W1).value;
  assert.equal(updated.revision, 2); assert.deepEqual(updated.points, [{ x: -100.125, y: 2500.75, pressure: 0.72 }]);
  assert.equal(updated.parameters.size, 8); assert.equal(updated.style['a3.ui.stroke.color'], '#78a9d1');
  assert.deepEqual(updated.style['future.keep'], { yes: true });
  const inverseSource = reversibleCanvasCommand(updatedPlan, W1).changes[0];
  assert.deepEqual(inverseSource.before.value.points, drawingRecord().value.points);
  assert.deepEqual(inverseSource.after.value.points, updated.points);
  assert.deepEqual(find(updatedPlan.nextSnapshot, 'drawing', drawingRef.id, W2), undefined);

  const groupRef = { kind: 'group', id: id(802), workspaceId: W1 };
  const withGroup = success(run(updatedPlan.nextSnapshot, 'a3.core.create-document', { record: { kind: 'group', workspaceId: W1,
    value: freshDocument(802, { name: 'Anotaciones', members: [{ kind: 'drawing', id: drawingRef.id }] }) } }, [groupRef])).nextSnapshot;
  const deleted = success(run(withGroup, 'a3.core.delete', { ref: drawingRef })).nextSnapshot;
  assert.equal(find(deleted, 'drawing', drawingRef.id, W1), undefined);
  assert.deepEqual(find(deleted, 'group', groupRef.id, W1).value.members, []);
  assert.deepEqual(find(deleted, 'entity', '00000000-0000-4000-8000-000000000002'), find(state, 'entity', '00000000-0000-4000-8000-000000000002'));
  assert.deepEqual(state, fixture(), 'commands do not mutate their input');
});

test('drawing codec rejects bad points, pressure, parameters and cross-workspace history', () => {
  const state = fixture();
  rejection(run(state, 'a3.core.create-document', { record: drawingRecord({ points: [] }) }, [drawingRef]));
  rejection(run(state, 'a3.core.create-document', { record: drawingRecord({ points: [{ x: 1, y: 2, pressure: 1.1 }] }) }, [drawingRef]));
  rejection(run(state, 'a3.core.create-document', { record: drawingRecord({ parameters: { ...parameters, size: 0 } }) }, [drawingRef]));
  const created = success(run(state, 'a3.core.create-document', { record: drawingRecord() }, [drawingRef]));
  assert.throws(() => reversibleCanvasCommand(created, W2), /otro workspace/);
  rejection(run(created.nextSnapshot, 'a3.core.update-drawing', { ref: drawingRef, points: [{ x: NaN, y: 0 }] }));
  rejection(run(created.nextSnapshot, 'a3.core.update-drawing', { ref: { ...drawingRef, workspaceId: W2 }, style: { 'a3.ui.stroke.color': '#ffffff' } }));
});

test('converting strokes creates an editable vector resource, entity and placement in one reversible plan', () => {
  const state = fixture();
  const drawings = [801, 803].map((number) => {
    const ref = { kind: 'drawing', id: id(number), workspaceId: W1 };
    state.records.push({ kind: 'drawing', workspaceId: W1, value: freshDocument(number, { points: [{ x: number, y: 2, pressure: 0.7 }],
      parameters, style: { 'a3.ui.stroke.color': '#c3ed82' } }) });
    return ref;
  });
  const entityId = id(804), resourceId = id(805), placementId = id(806);
  const payload = { workspaceId: W1, drawingIds: drawings.map(({ id }) => id), entityId, resourceId, placementId, title: 'Esquema' };
  const refs = [{ kind: 'entity', id: entityId }, { kind: 'resource', id: resourceId }, { kind: 'placement', id: placementId, workspaceId: W1 }];
  const result = success(run(state, 'a3.core.convert-drawings-to-node', payload, refs, undefined, { scope: { entityIds: [...state.records.filter((record) => record.kind === 'entity').map((record) => record.value.id), entityId] } }));
  const node = find(result.nextSnapshot, 'entity', entityId), resource = find(result.nextSnapshot, 'resource', resourceId), placement = find(result.nextSnapshot, 'placement', placementId, W1);
  assert.equal(node.value.type, 'a3.core.drawing'); assert.equal(node.value.contentResourceId, resourceId);
  assert.equal(resource.value.kind, 'project-file'); assert.equal(resource.value.path, `assets/drawings/${resourceId}.json`);
  assert.equal(placement.value.entityId, entityId); assert.deepEqual(placement.value.position, { x: 801, y: 2 });
  assert.equal(find(result.nextSnapshot, 'drawing', drawings[0].id, W1), undefined); assert.equal(find(result.nextSnapshot, 'drawing', drawings[1].id, W1), undefined);
  const asset = JSON.parse(result.contentEffects[0].content);
  assert.equal(asset.strokes.length, 2); assert.equal(asset.strokes[0].points[0].pressure, 0.7);
  const reversible = reversibleCanvasCommand(result, W1);
  assert.deepEqual(reversible.contentEffects, result.contentEffects, 'the shared history event retains created vector bytes for replay/inversion');
  assert.ok(reversible.changes.some((change) => change.ref.kind === 'resource' && change.after.value.id === resourceId));
  assert.deepEqual(find(result.nextSnapshot, 'relation', '00000000-0000-4000-8000-000000000005'), find(state, 'relation', '00000000-0000-4000-8000-000000000005'));
  assert.ok(result.changes.some((change) => change.ref.kind === 'drawing' && change.before && !change.after));
  assert.deepEqual(state.records.filter((record) => record.kind === 'drawing').length, 2, 'conversion never mutates input records');
});

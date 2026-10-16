import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, context, id, W1, W2, E1, P1, P2, P3, REL, find, group, freshDocument, run, success, rejection } from './fixture.mjs';

const edgeRef = { kind: 'visual-edge', id: id(701), workspaceId: W1 };
test('A3-006: create, reconnect, style and remove a VisualEdge without changing technical relations or shared entities', () => {
  const original = fixture();
  const created = success(run(original, 'a3.core.create-document', { record: { kind: 'visual-edge', workspaceId: W1, value: freshDocument(701, {
    sourcePlacementId: P1, targetPlacementId: P2, label: 'Idea', waypoints: [], style: { 'future.keep': { retained: true } }
  }) } }, [edgeRef])).nextSnapshot;
  const updated = success(run(created, 'a3.core.update-visual-edge', { ref: edgeRef, sourcePlacementId: P2, targetPlacementId: P1,
    label: 'Solo organización', waypoints: [{ x: 1.25, y: -12 }], style: { 'a3.ui.line.direction': 'both', 'a3.ui.line.route': 'orthogonal' }
  })).nextSnapshot;
  const value = find(updated, 'visual-edge', edgeRef.id, W1).value;
  assert.equal(value.revision, 2); assert.equal(value.sourcePlacementId, P2); assert.equal(value.targetPlacementId, P1);
  assert.deepEqual(value.style['future.keep'], { retained: true }); assert.deepEqual(value.waypoints, [{ x: 1.25, y: -12 }]);
  assert.deepEqual(find(updated, 'entity', E1), find(original, 'entity', E1));
  // A technical export reads Relation records, never the presentation documents.
  const technicalRecords = (state) => state.records.filter((record) => ['relation', 'relation-view'].includes(record.kind));
  assert.deepEqual(technicalRecords(updated), technicalRecords(original));
  assert.equal(find(updated, 'relation', REL).value.id, REL);
  const removed = success(run(updated, 'a3.core.delete', { ref: edgeRef })).nextSnapshot;
  assert.equal(find(removed, 'visual-edge', edgeRef.id, W1), undefined);
  assert.deepEqual(technicalRecords(removed), technicalRecords(original));
  assert.deepEqual(original, fixture(), 'all commands are pure');
});

test('VisualEdge reconnection rejects missing/cross-workspace endpoints, identity patches, invalid geometry and stale revisions', () => {
  const state = fixture(), existing = state.records.find((record) => record.kind === 'visual-edge');
  const ref = { kind: 'visual-edge', id: existing.value.id, workspaceId: W1 };
  assert.equal(run(state, 'a3.core.update-visual-edge', { ref, targetPlacementId: P3 }).ok, false);
  assert.equal(run(state, 'a3.core.update-visual-edge', { ref, sourcePlacementId: id(9999) }).ok, false);
  rejection(run(state, 'a3.core.update-visual-edge', { ref, id: id(3) }), 'invalid-visual-edge-patch');
  assert.equal(run(state, 'a3.core.update-visual-edge', { ref, waypoints: [{ x: NaN, y: 0 }] }).ok, false);
  const next = success(run(state, 'a3.core.update-visual-edge', { ref, label: 'New' })).nextSnapshot;
  const expectedRevisions = state.records.map((record) => ({ kind: record.kind, id: record.value.id ?? record.value.projectId, ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}), revision: record.value.revision }));
  assert.equal(run(next, 'a3.core.update-visual-edge', { ref, label: 'Stale' }, [], context(), { expectedRevisions }).ok, false);
});

test('locked placements reject geometry commands, remain selectable data, and group moves leave locked documents untouched', () => {
  const state = fixture(); find(state, 'placement', P1, W1).value.style['a3.ui.locked'] = true;
  const ref = { kind: 'placement', id: P1, workspaceId: W1 };
  rejection(run(state, 'a3.core.move-placement', { ref, position: { x: 1, y: 2 } }), 'placement-locked');
  rejection(run(state, 'a3.core.update-placement-view', { ref, size: { width: 200, height: 200 } }), 'placement-locked');
  rejection(run(state, 'a3.core.update-placement-view', { ref, position: { x: 1, y: 2 }, style: { 'a3.ui.locked': false } }), 'placement-locked');
  rejection(run(state, 'a3.core.move-placements', { workspaceId: W1, placements: [{ id: P2, position: { x: 10, y: 20 } }, { id: P1, position: { x: 20, y: 30 } }] }), 'placement-locked');
  const g = group(702, [{ kind: 'placement', id: P1 }, { kind: 'placement', id: P2 }]); state.records.push(g);
  const grouped = success(run(state, 'a3.core.move-group', { ref: { kind: 'group', id: g.value.id, workspaceId: W1 }, offset: { x: 20, y: 30 } })).nextSnapshot;
  assert.deepEqual(find(grouped, 'placement', P1, W1), find(state, 'placement', P1, W1));
  assert.notDeepEqual(find(grouped, 'placement', P2, W1).value.position, find(state, 'placement', P2, W1).value.position);
  const unlocked = success(run(state, 'a3.core.update-placement-view', { ref, style: { 'a3.ui.locked': false } })).nextSnapshot;
  const moved = success(run(unlocked, 'a3.core.move-placements', { workspaceId: W1, placements: [{ id: P1, position: { x: 20, y: 30 } }, { id: P2, position: { x: 40, y: 60 } }] })).nextSnapshot;
  assert.deepEqual(find(moved, 'placement', P3, W2), find(state, 'placement', P3, W2));
  assert.deepEqual(find(moved, 'entity', E1), find(state, 'entity', E1));
  assert.deepEqual(find(moved, 'placement', P2, W1).value.position, { x: 40, y: 60 });
  rejection(run(unlocked, 'a3.core.move-placements', { workspaceId: W1, placements: [{ id: P1, position: { x: 1, y: 2 } }, { id: P1, position: { x: 3, y: 4 } }] }), 'invalid-placement-moves');
});

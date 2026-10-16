import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTENT_NODE_CATALOG, prepareCommand, reversibleCanvasCommand } from '../dist/src/index.js';
import { fixture, context, id, W1, R1, request, success } from './fixture.mjs';

test('A3-006/008/025: built-in content nodes create canonical records and a reversible workspace event', () => {
  let state = fixture();
  const inline = new Map([['page', '# Página\n'], ['short-text', 'Una idea'], ['code', 'const answer = 42;'], ['drawing', '{"schemaVersion":"1.0.0","strokes":[]}\n']]);
  const urls = new Map([['youtube', 'https://youtu.be/dQw4w9WgXcQ'], ['web-link', 'https://example.com/reference']]);
  for (let index = 0; index < CONTENT_NODE_CATALOG.length; index++) {
    const definition = CONTENT_NODE_CATALOG[index], entityId = id(400 + index * 3), resourceId = id(401 + index * 3), placementId = id(402 + index * 3);
    const source = definition.source === 'inline' ? { kind: 'inline', resourceId, path: `content/${resourceId}${definition.extension}`, mediaType: definition.mediaType, content: inline.get(definition.kind) } :
      definition.source === 'url' ? { kind: 'url', resourceId, url: urls.get(definition.kind) } : { kind: 'existing-resource', resourceId: R1 };
    const refs = [{ kind: 'entity', id: entityId }, { kind: 'placement', id: placementId, workspaceId: W1 },
      ...(definition.source === 'resource' ? [] : [{ kind: 'resource', id: resourceId }])];
    const result = success(prepareCommand(state, request(state, 'a3.core.create-content-node', {
      workspaceId: W1, kind: definition.kind, entityId, placementId, title: definition.label, position: { x: index * 350, y: -index * 15 }, properties: {}, source
    }, refs, { scope: { entityIds: [entityId] } }), context()));
    state = result.nextSnapshot;
    const entity = state.records.find((record) => record.kind === 'entity' && record.value.id === entityId);
    const placement = state.records.find((record) => record.kind === 'placement' && record.value.id === placementId);
    assert.equal(entity.value.type, definition.type);
    assert.equal(entity.value.contentResourceId, definition.source === 'resource' ? R1 : resourceId);
    assert.equal(placement.value.entityId, entityId);
    assert.equal(result.changes.length, definition.source === 'resource' ? 2 : 3);
    assert.equal(result.contentEffects.length, definition.source === 'inline' ? 1 : 0);
    const event = reversibleCanvasCommand(result, W1);
    assert.equal(event.workspaceId, W1);
    assert.equal(event.command, 'a3.core.create-content-node');
  }
});

test('content node creation rejects active schemes and does not let an external request create source files', () => {
  const state = fixture(), before = structuredClone(state), entityId = id(500), resourceId = id(501), placementId = id(502);
  const refs = [{ kind: 'entity', id: entityId }, { kind: 'resource', id: resourceId }, { kind: 'placement', id: placementId, workspaceId: W1 }];
  const payload = { workspaceId: W1, kind: 'web-link', entityId, resourceId, placementId, title: 'Bad link', position: { x: 0, y: 0 }, properties: {},
    source: { kind: 'url', resourceId, url: 'javascript:alert(1)' } };
  const result = prepareCommand(state, request(state, 'a3.core.create-content-node', payload, refs, { scope: { entityIds: [entityId] } }), context());
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.detail === 'invalid-content-url'));
  assert.deepEqual(state, before);
});

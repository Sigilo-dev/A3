import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRegistry, refOf, revisionsOf, prepareCommand } from '../dist/src/index.js';

export const fixtureRoot = fileURLToPath(new URL('../../../fixtures/e0/project/', import.meta.url));
export const id = (n) => '90000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
export const actor = { kind: 'user', id: 'local-user' };
export const hash = 'a'.repeat(64);
export const W1 = '00000000-0000-4000-8000-000000000006';
export const W2 = '00000000-0000-4000-8000-000000000007';
export const E1 = '00000000-0000-4000-8000-000000000002';
export const E2 = '00000000-0000-4000-8000-000000000003';
export const R1 = '00000000-0000-4000-8000-000000000004';
export const P1 = '00000000-0000-4000-8000-000000000008';
export const P2 = '00000000-0000-4000-8000-000000000010';
export const P3 = '00000000-0000-4000-8000-000000000009';
export const REL = '00000000-0000-4000-8000-000000000005';

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)]);
}
export function fixture() {
  return { records: walk(fixtureRoot).filter((path) => path.endsWith('.json')).map((path) => {
    const parts = relative(fixtureRoot, path).split(sep);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const folder = parts.at(-2);
    const kind = parts.length === 1 ? 'project' : parts.at(-1) === 'workspace.json' ? 'workspace' :
      { entities: 'entity', resources: 'resource', relations: 'relation', placements: 'placement', 'visual-edges': 'visual-edge', 'relation-views': 'relation-view' }[folder];
    return { kind, value, ...(['placement', 'visual-edge', 'relation-view'].includes(kind) ? { workspaceId: parts[2] } : {}) };
  }) };
}
export const find = (state, kind, recordId, workspaceId) => state.records.find((r) => r.kind === kind &&
  (r.value.id ?? r.value.projectId ?? r.value.scope?.ownerId).toLowerCase() === recordId.toLowerCase() &&
  (!workspaceId || r.workspaceId === workspaceId));
export const context = (overrides = {}) => ({ authenticatedActor: actor, authorization: { authorize: () => true }, registry: defaultRegistry(), contentHashes: { [R1]: hash }, ...overrides });
export const freshDocument = (n, extra) => ({ schemaVersion: '1.0.0', id: id(n), revision: 1, extensions: {}, ...extra });
export const group = (n, members = [], workspaceId = W1) => ({ kind: 'group', workspaceId, value: freshDocument(n, { name: 'Grupo', members }) });
export const collection = (n, entityIds = []) => ({ kind: 'collection', value: freshDocument(n, { name: 'Colección', entityIds }) });
export const variableSet = (scope, variables) => ({ kind: 'variable-set', value: { schemaVersion: '1.0.0', revision: 1, scope, variables, extensions: {} } });
export const literal = (name, value, valueType = 'string') => ({ name, valueType, source: { kind: 'literal', value } });

export function request(state, command, payload, createdRefs = [], overrides = {}) {
  const extraEntityIds = [...(payload.ids ? Object.values(payload.ids.entities ?? {}) : []),
    ...(payload.record?.kind === 'entity' ? [payload.record.value.id] : [])];
  return { operationId: id(999), projectId: state.records.find((r) => r.kind === 'project')?.value.projectId ?? payload.project?.projectId,
    actor, command, payload, scope: { entityIds: [...new Set([...state.records.filter((r) => r.kind === 'entity').map((r) => r.value.id), ...extraEntityIds])] },
    expectedRevisions: [...revisionsOf(state), ...createdRefs.map((ref) => ({ ...ref, revision: null }))],
    expectedContentHashes: [{ resourceId: R1, hash }], ...overrides };
}
export function run(state, command, payload, createdRefs = [], ctx = context(), overrides = {}) {
  return prepareCommand(state, request(state, command, payload, createdRefs, overrides), ctx);
}
export function success(result) {
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.value.status, 'prepared');
  return result.value;
}
export function rejection(result, detail) {
  assert.equal(result.ok, false);
  if (detail) assert.ok(result.diagnostics.some((d) => d.detail === detail), JSON.stringify(result.diagnostics));
  return result;
}
export function duplicatePayload(state, mode = 'content') {
  const payload = { workspaceId: W1, placementIds: [P1, P2], mode, offset: { x: 40, y: 60 }, includeExternalRelations: false,
    ids: { entities: { [E1]: id(102), [E2]: id(103) }, placements: { [P1]: id(108), [P2]: id(110) },
      relations: { [REL]: id(105) }, visualEdges: {}, relationViews: {} },
    resourceCopies: [{ sourceId: R1, id: id(104), location: { kind: 'project-file', path: 'pages/readme-copy.md' } }] };
  for (const record of state.records.filter((r) => r.workspaceId === W1)) {
    if (record.kind === 'visual-edge') payload.ids.visualEdges[record.value.id] = id(111);
    if (record.kind === 'relation-view') payload.ids.relationViews[record.value.id] = id(112);
  }
  const refs = [
    ...Object.values(payload.ids.placements).map((recordId) => ({ kind: 'placement', id: recordId, workspaceId: W1 })),
    ...Object.values(payload.ids.visualEdges).map((recordId) => ({ kind: 'visual-edge', id: recordId, workspaceId: W1 })),
    ...Object.values(payload.ids.relationViews).map((recordId) => ({ kind: 'relation-view', id: recordId, workspaceId: W1 }))
  ];
  if (mode === 'content') refs.push(...Object.values(payload.ids.entities).map((recordId) => ({ kind: 'entity', id: recordId })),
    { kind: 'resource', id: id(104) }, { kind: 'relation', id: id(105) });
  return { payload, refs };
}
export { refOf };

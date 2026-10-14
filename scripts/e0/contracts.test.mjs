import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = resolve(root, 'fixtures/e0/project');
const base = 'https://sigilo-dev.github.io/A3/schemas/e0/';
const read = (path) => readFileSync(path, 'utf8');
const json = (path) => JSON.parse(read(path));
const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const child = resolve(path, entry.name);
  return entry.isDirectory() ? walk(child) : [child];
});
const ajv = new Ajv2020({ allErrors: true, strict: true });
// Small explicit formats keep this harness to the single chosen schema dependency.
ajv.addFormat('utc-date-time', (value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value.replace('Z', '.000Z');
});
ajv.addFormat('absolute-url', (value) => {
  try { return Boolean(new URL(value).protocol); } catch { return false; }
});
const schemaFiles = walk(resolve(root, 'schemas/e0')).filter((p) => p.endsWith('.json'));
for (const path of schemaFiles) ajv.addSchema(json(path));
const validate = (kind, value) => ajv.getSchema(`${base}${kind}.schema.json`)(value);
const kindFor = (path) => {
  if (path === 'a3.project.json') return 'project';
  if (path.endsWith('/workspace.json')) return 'workspace';
  const folder = path.split('/').at(-2);
  return { entities: 'entity', resources: 'resource', relations: 'relation',
    placements: 'placement', 'visual-edges': 'visual-edge', 'relation-views': 'relation-view' }[folder];
};
const records = walk(fixtureRoot).filter((p) => p.endsWith('.json')).map((path) => {
  const name = relative(fixtureRoot, path).split(sep).join('/');
  return { path: name, kind: kindFor(name), value: json(path) };
});
const first = (list, kind) => list.find((r) => r.kind === kind).value;

// Deliberately limited to the fixture graph; this is not a project loader/store.
function validateGraph(list) {
  const errors = [];
  const byKind = (kind) => list.filter((r) => r.kind === kind);
  const lookup = (kind, id) => byKind(kind).find((r) => r.value.id === id);
  const workspace = (record) => record.path.split('/')[2];
  const fail = (condition, code) => { if (!condition) errors.push(code); };
  const seen = new Set();
  for (const r of list) {
    const id = r.value.id ?? r.value.projectId;
    fail(!seen.has(id), 'duplicate-id'); seen.add(id);
    if (r.kind === 'project') continue;
    const expected = r.kind === 'workspace' ? `${id}/workspace.json` : `${id}.json`;
    fail(r.path.endsWith(`/${expected}`), 'filename-id');
    if (r.path.includes('/workspaces/')) fail(Boolean(lookup('workspace', workspace(r))), 'workspace-missing');
  }
  const project = first(list, 'project');
  fail(Boolean(lookup('workspace', project.defaultWorkspaceId)), 'default-workspace-missing');
  for (const r of byKind('entity')) {
    if (r.value.contentResourceId) fail(Boolean(lookup('resource', r.value.contentResourceId)), 'resource-missing');
    const ports = r.value.ports.map((p) => p.id);
    fail(new Set(ports).size === ports.length, 'duplicate-port');
  }
  for (const r of byKind('resource')) {
    if (r.value.kind !== 'project-file') continue;
    const path = resolve(fixtureRoot, r.value.path);
    fail(path.startsWith(fixtureRoot + sep), 'path-outside-fixture');
    // Only read synthetic fixture content after lexical containment; no mounts/network.
    if (path.startsWith(fixtureRoot + sep)) {
      try { read(path); } catch { errors.push('file-missing'); }
    }
  }
  for (const r of byKind('placement')) fail(Boolean(lookup('entity', r.value.entityId)), 'entity-missing');
  for (const r of byKind('relation')) {
    for (const end of [r.value.source, r.value.target]) {
      const entity = lookup('entity', end.entityId)?.value;
      fail(Boolean(entity), 'relation-entity-missing');
      if (end.portId) fail(Boolean(entity?.ports.some((p) => p.id === end.portId)), 'port-missing');
    }
  }
  for (const r of [...byKind('visual-edge'), ...byKind('relation-view')]) {
    const local = (id) => byKind('placement').find((p) => p.value.id === id && workspace(p) === workspace(r));
    const source = local(r.value.sourcePlacementId);
    const target = local(r.value.targetPlacementId);
    fail(Boolean(source && target), 'placement-not-local');
    if (r.kind === 'relation-view') {
      const relation = lookup('relation', r.value.relationId)?.value;
      fail(Boolean(relation), 'relation-missing');
      if (relation && source && target) fail(
        source.value.entityId === relation.source.entityId && target.value.entityId === relation.target.entityId,
        'relation-view-endpoints');
    }
  }
  return errors;
}

test('schemas compile; all fixture documents and declarative manifest validate', () => {
  for (const path of schemaFiles) assert.ok(ajv.getSchema(json(path).$id));
  for (const r of records) assert.ok(validate(r.kind, r.value), `${r.path}: ${ajv.errorsText(ajv.getSchema(base + r.kind + '.schema.json').errors)}`);
  assert.ok(validate('package-manifest', json(resolve(root, 'fixtures/e0/declarative-package.json'))));
  assert.deepEqual(validateGraph(records), []);
});

test('fixtures are strict UTF-8 JSON with two-space indentation and final LF', () => {
  const files = [...schemaFiles, ...walk(resolve(root, 'fixtures/e0')).filter((p) => p.endsWith('.json'))];
  for (const path of files) {
    const bytes = readFileSync(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', path);
  }
});

const cases = json(resolve(root, 'fixtures/e0/invalid-cases.json'));
for (const c of cases) test(`negative schema: ${c.name}`, () => {
  const data = structuredClone(c.kind === 'package-manifest'
    ? json(resolve(root, 'fixtures/e0/declarative-package.json')) : first(records, c.kind));
  let owner = data;
  for (const part of c.path.slice(0, -1)) owner = owner[part];
  if (c.remove) delete owner[c.path.at(-1)]; else owner[c.path.at(-1)] = c.value;
  assert.equal(validate(c.kind, data), false, c.name);
});

for (const [name, kind, mutate, diagnostic] of [
  ['dangling resource', 'entity', (v) => { v.contentResourceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'resource-missing'],
  ['absent port', 'relation', (v) => { v.source.portId = 'missing'; }, 'port-missing'],
  ['wrong relation view', 'relation-view', (v) => { [v.sourcePlacementId, v.targetPlacementId] = [v.targetPlacementId, v.sourcePlacementId]; }, 'relation-view-endpoints'],
  ['cross-workspace edge', 'visual-edge', (v) => { v.targetPlacementId = records.filter((r) => r.kind === 'placement').at(-1).value.id; }, 'placement-not-local'],
  ['unknown default workspace', 'project', (v) => { v.defaultWorkspaceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'default-workspace-missing'],
  ['missing file', 'resource', (v) => { v.path = 'pages/absent.md'; }, 'file-missing'],
]) test(`negative graph: ${name} passes schema but fails references`, () => {
  const copy = structuredClone(records); mutate(first(copy, kind));
  for (const r of copy) assert.ok(validate(r.kind, r.value));
  assert.ok(validateGraph(copy).includes(diagnostic));
});

test('one Markdown resource is shared by placements in two workspaces', () => {
  const page = first(records, 'entity');
  const placements = records.filter((r) => r.kind === 'placement' && r.value.entityId === page.id);
  assert.equal(placements.length, 2);
  assert.equal(new Set(placements.map((r) => dirname(dirname(r.path)))).size, 2);
  const resource = records.find((r) => r.kind === 'resource' && r.value.id === page.contentResourceId).value;
  assert.equal(resource.mediaType, 'text/markdown');
  assert.match(read(resolve(fixtureRoot, resource.path)), /^# Visión/);
  assert.equal(records.filter((r) => r.kind === 'visual-edge').length, 1);
  assert.equal(records.filter((r) => r.kind === 'relation').length, 1);
});

test('schema validation preserves unknown data without coercion or removal', () => {
  const value = structuredClone(first(records, 'entity'));
  value.futureField = { opaque: [1, 'texto', null] };
  const before = JSON.stringify(value);
  assert.ok(validate('entity', value));
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('resource alternatives accept exclusive mounted and remote locations', () => {
  const original = first(records, 'resource');
  const { path, ...rest } = original;
  assert.ok(validate('resource', { ...rest, kind: 'remote-url', url: 'https://example.com/document' }));
  assert.ok(validate('resource', { ...original, kind: 'mounted-file', mountId: original.id }));
});

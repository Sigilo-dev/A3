import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addDeclarativeNodePackage, createDeclarativeNodePackage, defaultRegistry, validateDeclarativeNodePackage, validateSnapshot } from '../dist/src/index.js';
import { fixture, find, E1, E2, REL } from './fixture.mjs';

const packageFixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/declarative-node-package.json', import.meta.url)), 'utf8'));
const clone = (value) => structuredClone(value);

test('A3-041/042: data-only node package validates typed fields, ports, styles, mappings, and collection membership', () => {
  assert.deepEqual(validateDeclarativeNodePackage(packageFixture), []);
  const registry = defaultRegistry();
  const added = addDeclarativeNodePackage(registry, packageFixture);
  assert.deepEqual(added.diagnostics, []);
  assert.equal(added.registry.nodeTypes.some((type) => type.name === 'community.example-nodes.sensor'), true);
  assert.equal(registry.nodeTypes.some((type) => type.name === 'community.example-nodes.sensor'), false, 'adding a package does not mutate the caller registry');
  assert.deepEqual(added.registry.nodeTypes.at(-1).ports.map(({ id, direction }) => ({ id, direction })), [
    { id: 'community.example-nodes.sensor.signal', direction: 'output' }
  ]);
  const created = createDeclarativeNodePackage({ id: packageFixture.manifest.id, name: packageFixture.manifest.name,
    version: packageFixture.manifest.version, license: packageFixture.manifest.license, a3ApiVersion: packageFixture.manifest.a3ApiVersion,
    nodeTypes: packageFixture.nodeTypes, collections: packageFixture.collections });
  assert.deepEqual(validateDeclarativeNodePackage(created), []);
});

test('A3-041: schema, identity, defaults, and collection references are checked before registration', () => {
  for (const mutate of [
    (value) => { value.nodeTypes[0].name = 'not a namespace'; },
    (value) => { value.nodeTypes[0].fields[0].defaultValue = false; },
    (value) => { value.collections[0].typeRefs[0].version = '2.0.0'; },
    (value) => { value.nodeTypes[0].ports[0].multiplicity = { min: 2, max: 1 }; },
    (value) => { value.manifest.contributes['a3.node-types'].types = []; }
  ]) {
    const invalid = clone(packageFixture); mutate(invalid);
    assert.ok(validateDeclarativeNodePackage(invalid).length > 0);
    const before = defaultRegistry();
    const result = addDeclarativeNodePackage(before, invalid);
    assert.ok(result.diagnostics.length > 0);
    assert.deepEqual(result.registry, before);
  }
});

test('A3-041: package permissions and executable-looking data remain inert and are rejected', () => {
  for (const mutate of [
    (value) => { value.manifest.permissions = ['network.access']; },
    (value) => { value.manifest.entrypoints = { main: 'index.js' }; },
    (value) => { value.nodeTypes[0].extensions['community.example-nodes.code'] = { code: 'return 1' }; }
  ]) {
    const invalid = clone(packageFixture); mutate(invalid);
    assert.ok(validateDeclarativeNodePackage(invalid).length > 0);
  }
});

test('A3-041: package type versions are immutable in a registry', () => {
  const registry = addDeclarativeNodePackage(defaultRegistry(), packageFixture).registry;
  const duplicate = addDeclarativeNodePackage(registry, packageFixture);
  assert.ok(duplicate.diagnostics.some((item) => item.detail === 'node-type-version-exists'));
  assert.equal(duplicate.registry.nodeTypes.filter((type) => type.name === packageFixture.nodeTypes[0].name).length, 1);
});

test('A3-042: unavailable custom type falls back without dropping stored fields, ports, or relation endpoints', () => {
  const state = fixture();
  const source = find(state, 'entity', E1); const target = find(state, 'entity', E2); const relation = find(state, 'relation', REL);
  source.value.type = 'community.missing.sensor'; source.value.typeVersion = '3.1.0';
  source.value.properties['community.missing.details'] = { retained: 'source data' };
  source.value.ports = [{ id: 'community.missing.out', label: 'Salida' }];
  target.value.ports = [{ id: 'community.missing.in', label: 'Entrada' }];
  relation.value.source.portId = 'community.missing.out'; relation.value.target.portId = 'community.missing.in';
  const before = structuredClone(state.records);
  const diagnostics = validateSnapshot(state, defaultRegistry());
  assert.ok(diagnostics.some((item) => item.detail === 'node-type-unavailable' && item.severity === 'warning'));
  assert.deepEqual(state.records, before, 'read-only validation never rewrites or strips fallback data');
  assert.deepEqual(source.value.ports.map((port) => port.id), ['community.missing.out']);
  assert.equal(relation.value.source.portId, 'community.missing.out');
});

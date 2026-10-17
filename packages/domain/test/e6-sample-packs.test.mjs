import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { addDeclarativeNodePackage, c4Category, defaultRegistry, emptyExtensionRegistry, isIotComponent,
  registerExtensionPackage, resolveExtensionRegistry, retireExtensionPackage, validateDeclarativeNodePackage, validateVersionedExtensionPackage } from '../dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '../../../fixtures/e6/extensions');
const fixture = (name) => JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));

test('E6-F2: sample extension bundle validates against JSON Schema and exact A3 point contracts', () => {
  const bundle = fixture('community-samples.json');
  const schema = JSON.parse(readFileSync(join(here, '../../../schemas/e6/versioned-extension-bundle.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(bundle), true, JSON.stringify(validate.errors));
  assert.deepEqual(validateVersionedExtensionPackage(bundle), []);
  assert.equal(bundle.manifest.license, 'MIT');
  assert.equal(bundle.manifest.version, '1.0.0');
  assert.equal(bundle.manifest.a3ApiVersion, '1.0.0');
  assert.equal(bundle.manifest.obsidianCompatibility, 'not-asserted');

  let registry = emptyExtensionRegistry();
  const registered = registerExtensionPackage(registry, bundle);
  assert.deepEqual(registered.diagnostics, []);
  registry = registered.registry;
  const report = resolveExtensionRegistry(registry);
  const byId = Object.fromEntries(report.resolutions.map((item) => [item.contributionId, item]));
  assert.equal(byId['community.a3-samples.paper-theme'].effective, true);
  assert.equal(byId['community.a3-samples.markdown-callout'].fallback, 'source-only');
  assert.equal(bundle.contributions.find(({ extensionPoint }) => extensionPoint === 'a3.markdown').payload.unknownSource, 'preserve');
  assert.deepEqual(bundle.contributions.filter(({ extensionPoint }) => extensionPoint === 'a3.provider').map(({ payload }) => payload.origin).sort(),
    ['https://claude.ai', 'https://gemini.google.com']);
  assert.ok(report.resolutions.filter(({ extensionPoint }) => extensionPoint === 'a3.provider').every(({ status, effective, fallback }) =>
    status === 'declared-only' && !effective && fallback === 'manual-prompt'));
  assert.ok(report.resolutions.filter(({ extensionPoint }) => extensionPoint === 'a3.automation').every(({ status, effective, fallback }) =>
    status === 'declared-only' && !effective && fallback === 'no-automation'));
  assert.deepEqual(bundle.contributions.filter(({ extensionPoint }) => extensionPoint === 'a3.automation')[0].payload.permissions, []);

  const retired = retireExtensionPackage(registry, bundle.manifest.id, bundle.manifest.version);
  assert.deepEqual(retired.diagnostics, []);
  assert.ok(resolveExtensionRegistry(retired.registry).resolutions.every(({ status, effective }) => status === 'retired' && !effective));
  assert.deepEqual(retired.registry.packages[0].bundle, bundle, 'retire keeps the full package data for inspection or reactivation');
});

test('E6-F2/A3-041: C4 sample declares its category explicitly and IoT sample stays a reference card', () => {
  const c4 = fixture('c4-service-node.json');
  assert.deepEqual(validateDeclarativeNodePackage(c4), []);
  assert.equal(c4.nodeTypes[0].extensions['a3.c4.category'], 'component');
  const c4Registry = addDeclarativeNodePackage(defaultRegistry(), c4);
  assert.deepEqual(c4Registry.diagnostics, []);
  assert.equal(c4Category({ type: c4.nodeTypes[0].name, typeVersion: c4.nodeTypes[0].version }, c4Registry.registry), 'component');

  const iot = fixture('iot-bme280-reference.json');
  assert.deepEqual(validateDeclarativeNodePackage(iot), []);
  const type = iot.nodeTypes[0];
  assert.equal(type.name, 'community.a3-samples-iot.bme280-reference');
  assert.equal(type.extensions['community.a3-samples-iot.canonical-iot-semantics'], false);
  assert.match(type.fields.find(({ name }) => name.endsWith('.component-revision')).defaultValue, /unknown/);
  assert.match(type.fields.find(({ name }) => name.endsWith('.known-electrical-limits')).defaultValue, /not modeled/);
  assert.equal(type.ports[0].id, 'community.a3-samples-iot.bme280.catalog-reference');
  assert.equal(isIotComponent({ type: type.name, typeVersion: type.version, properties: {}, ports: [] }), false);
});

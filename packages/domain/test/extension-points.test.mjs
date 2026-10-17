import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { A3_EXTENSION_POINTS, activateExtensionPackage, deactivateExtensionPackage, emptyExtensionRegistry, registerExtensionPackage,
  resolveExtensionRegistry, retireExtensionPackage, validateExtensionRegistry, validateVersionedExtensionPackage } from '../dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const clone = (value) => structuredClone(value);

test('E6-F1: JSON Schema validates the portable bundle envelope and rejects compatibility claims', () => {
  const schema = JSON.parse(readFileSync(join(here, '../../../schemas/e6/versioned-extension-bundle.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(fixture('versioned-extension-bundle.json')), true);
  const invalid = fixture('versioned-extension-bundle.json'); invalid.manifest.obsidianCompatibility = 'compatible';
  assert.equal(validate(invalid), false);
});

test('A3-041/042: versioned extension fixture registers typed data-only points and preserves unknown metadata', () => {
  const bundle = fixture('versioned-extension-bundle.json');
  assert.deepEqual(validateVersionedExtensionPackage(bundle), []);
  assert.deepEqual(Object.values(A3_EXTENSION_POINTS).map(({ apiVersion }) => apiVersion), ['1.0.0', '1.0.0', '1.0.0', '1.0.0', '1.0.0']);
  const registered = registerExtensionPackage(emptyExtensionRegistry(), bundle);
  assert.deepEqual(registered.diagnostics, []);
  assert.equal(registered.registry.packages[0].bundle.extensions['community.a3-design-tools.future-metadata'].retained, true);
  const report = resolveExtensionRegistry(registered.registry);
  assert.equal(report.resolutions.filter(({ status }) => status === 'active').length, 3);
  assert.equal(report.resolutions.filter(({ status }) => status === 'declared-only').length, 3);
  assert.equal(report.resolutions.find(({ extensionPoint }) => extensionPoint === 'a3.theme').effective, true);
  assert.equal(report.resolutions.find(({ extensionPoint }) => extensionPoint === 'a3.provider').effective, false, 'provider code does not enter the extension runtime');
  assert.equal(report.resolutions.find(({ extensionPoint }) => extensionPoint === 'a3.automation').effective, false, 'automation declarations do not execute');
  assert.equal(report.resolutions.find(({ contributionId }) => contributionId.endsWith('.agent')).fallback, 'manual-prompt');
  assert.equal(report.diagnostics.length, 3, 'providers and automation are declared but unavailable without their runtime');
});

test('E6-F1: unsupported API versions retain their package and resolve to a safe fallback', () => {
  const bundle = fixture('incompatible-extension-bundle.json');
  assert.deepEqual(validateVersionedExtensionPackage(bundle), [], 'a future point API is valid package data');
  const { registry, diagnostics } = registerExtensionPackage(emptyExtensionRegistry(), bundle);
  assert.deepEqual(diagnostics, []);
  const report = resolveExtensionRegistry(registry);
  assert.deepEqual(report.resolutions.map(({ status, fallback, effective }) => ({ status, fallback, effective })), [
    { status: 'incompatible', fallback: 'plain-text', effective: false }
  ]);
  assert.equal(registry.packages[0].bundle.contributions[0].apiVersion, '2.0.0');
  assert.equal(report.diagnostics[0].detail, 'extension-incompatible');
});

test('E6-F1: package versions are immutable, repeated registration is idempotent, and unknown points stay inert', () => {
  const bundle = fixture('versioned-extension-bundle.json');
  const first = registerExtensionPackage(emptyExtensionRegistry(), bundle);
  const again = registerExtensionPackage(first.registry, bundle);
  assert.deepEqual(again.diagnostics, []);
  assert.equal(again.registry.packages.length, 1);
  const changed = clone(bundle); changed.contributions[0].payload.tokens['color.accent'] = '#ff00ff';
  const rejected = registerExtensionPackage(first.registry, changed);
  assert.ok(rejected.diagnostics.some(({ detail }) => detail === 'extension-version-immutable'));
  assert.deepEqual(rejected.registry, first.registry);

  const future = clone(bundle);
  future.manifest.id = 'community.future-point'; future.manifest.name = 'Future Point';
  future.contributions = [{ id: 'community.future-point.custom', extensionPoint: 'community.future-point.v9', apiVersion: '9.0.0', payload: { opaque: true } }];
  const unknown = registerExtensionPackage(emptyExtensionRegistry(), future);
  assert.deepEqual(unknown.diagnostics, []);
  assert.deepEqual(resolveExtensionRegistry(unknown.registry).resolutions.map(({ status, fallback }) => ({ status, fallback })), [
    { status: 'unsupported', fallback: 'generic-data' }
  ]);
});

test('E6-F1: malformed or cyclic local registries produce diagnostics without being interpreted', () => {
  const corrupt = { schemaVersion: '1.0.0', packages: [], extensions: {} };
  corrupt.extensions.self = corrupt;
  assert.ok(validateExtensionRegistry(corrupt).length > 0);
  const report = resolveExtensionRegistry(corrupt);
  assert.deepEqual(report.resolutions, []);
  assert.ok(report.diagnostics.length > 0);
});

test('E6-F1: duplicate contribution IDs fail closed instead of choosing an install order', () => {
  const first = fixture('versioned-extension-bundle.json');
  first.contributions = [first.contributions[0]];
  const second = clone(first);
  second.manifest.id = 'community.another-theme';
  second.manifest.name = 'Another Theme';
  second.contributions[0].payload.tokens['color.background'] = '#ffffff';
  let registry = registerExtensionPackage(emptyExtensionRegistry(), first).registry;
  registry = registerExtensionPackage(registry, second).registry;
  const report = resolveExtensionRegistry(registry);
  assert.deepEqual(report.resolutions.map(({ status, effective, fallback }) => ({ status, effective, fallback })), [
    { status: 'conflict', effective: false, fallback: 'default-theme' },
    { status: 'conflict', effective: false, fallback: 'default-theme' }
  ]);
});

test('E6-F1: deactivation and retirement retain the bundle and route each point to fallback', () => {
  const bundle = fixture('versioned-extension-bundle.json');
  const before = JSON.stringify(bundle);
  let registry = registerExtensionPackage(emptyExtensionRegistry(), bundle).registry;
  const disabled = deactivateExtensionPackage(registry, bundle.manifest.id, bundle.manifest.version);
  assert.deepEqual(disabled.diagnostics, []);
  assert.ok(resolveExtensionRegistry(disabled.registry).resolutions.every(({ status, effective }) => status === 'inactive' && !effective));
  const retired = retireExtensionPackage(disabled.registry, bundle.manifest.id, bundle.manifest.version);
  assert.deepEqual(retired.diagnostics, []);
  assert.ok(resolveExtensionRegistry(retired.registry).resolutions.every(({ status, effective }) => status === 'retired' && !effective));
  assert.deepEqual(retired.registry.packages[0].bundle.contributions, bundle.contributions, 'retirement keeps extension payload for reinstall or inspection');
  assert.equal(JSON.stringify(bundle), before, 'lifecycle commands do not mutate caller data');
  const reactivated = activateExtensionPackage(retired.registry, bundle.manifest.id, bundle.manifest.version);
  assert.deepEqual(reactivated.diagnostics, []);
  assert.deepEqual(reactivated.registry.packages[0].bundle.contributions, bundle.contributions);
  assert.equal(resolveExtensionRegistry(reactivated.registry).resolutions[0].status, 'active', 'explicit activation restores only the data contract');
});

test('E6-F1: executable extension content and unsupported Obsidian compatibility claims are rejected', () => {
  for (const mutate of [
    (value) => { value.manifest.obsidianCompatibility = 'compatible'; },
    (value) => { value.contributions[0].payload.tokens['color.background'] = 'url(https://evil.test/x)'; },
    (value) => { value.contributions[2].payload.rules[0].regex = '.*'; },
    (value) => { value.contributions[3].payload.permissions = ['project.read']; }
  ]) {
    const invalid = fixture('versioned-extension-bundle.json'); mutate(invalid);
    assert.ok(validateVersionedExtensionPackage(invalid).length > 0);
  }
  const invalid = fixture('versioned-extension-bundle.json');
  invalid.contributions[0].payload.handler = 'process.exec';
  assert.ok(validateVersionedExtensionPackage(invalid).some(({ detail }) => detail === 'extension-package-executable-or-large'));
});

test('A3-009/042: retiring a Markdown contribution keeps the raw unsupported source and package data', () => {
  const sourcePath = join(here, '../../../experiments/e0/editors-canvas/fixtures/markdown.md');
  const source = readFileSync(sourcePath);
  const registry = registerExtensionPackage(emptyExtensionRegistry(), fixture('versioned-extension-bundle.json')).registry;
  const retired = retireExtensionPackage(registry, 'community.a3-design-tools', '1.0.0').registry;
  assert.deepEqual(readFileSync(sourcePath), source);
  assert.equal(retired.packages[0].bundle.contributions.find(({ extensionPoint }) => extensionPoint === 'a3.markdown').payload.unknownSource, 'preserve');
});

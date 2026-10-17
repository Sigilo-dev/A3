import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { LocalProjectManager, openProjectService, readDeclarativeNodePackages } from '../dist/index.js';
import { defaultRegistry, validateSnapshot } from '@a3/domain';
import { fixtureHost, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const packagePath = fileURLToPath(new URL('../../domain/test/fixtures/declarative-node-package.json', import.meta.url));
const lockFixturePath = fileURLToPath(new URL('../../../fixtures/e6/node-package-install-lock.json', import.meta.url));
const lockSchemaPath = fileURLToPath(new URL('../../../schemas/e1/node-package-install-lock.schema.json', import.meta.url));
const commonSchemaPath = fileURLToPath(new URL('../../../schemas/e0/common.schema.json', import.meta.url));
const lockPath = join('.a3', 'node-packages.lock.json');
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); return result.value; };
async function nodePackageLockValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('utc-date-time', (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)));
  ajv.addSchema(JSON.parse(await readFile(commonSchemaPath, 'utf8')));
  return ajv.compile(JSON.parse(await readFile(lockSchemaPath, 'utf8')));
}

test('E6-D2 installation lock fixture matches the versioned schema', async () => {
  const validate = await nodePackageLockValidator();
  const fixture = JSON.parse(await readFile(lockFixturePath, 'utf8'));
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(fixture); invalid.packages[0].integrity = '../outside';
  assert.equal(validate(invalid), false);
});

test('E6-D2 duplicate package ID/version records invalidate the lock without activating entries', async (t) => {
  const { root } = await scratch(t), lock = JSON.parse(await readFile(lockFixturePath, 'utf8'));
  lock.packages.push(structuredClone(lock.packages[0]));
  await writeFile(join(root, lockPath), JSON.stringify(lock, null, 2) + '\n');
  const catalog = await readDeclarativeNodePackages(root, '.a3', defaultRegistry());
  assert.equal(catalog.lockValid, false);
  assert.equal(catalog.packages.length, 0);
  assert.ok(catalog.diagnostics.some((item) => item.detail === 'node-package-lock-invalid'));
});

test('E6-D2 installed lock entry with an absent package stays inactive and reports the missing artifact', async (t) => {
  const { root, tempRoot } = await scratch(t), lock = JSON.parse(await readFile(lockFixturePath, 'utf8'));
  await writeFile(join(root, lockPath), JSON.stringify(lock, null, 2) + '\n');
  const catalog = await readDeclarativeNodePackages(root, '.a3', defaultRegistry());
  assert.equal(catalog.lockValid, true);
  assert.equal(catalog.packages.length, 0);
  assert.ok(catalog.diagnostics.some((item) => item.detail === 'node-package-artifact-missing'));
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host: await fixtureHost(root, 'node-package-missing-artifact') });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root), pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const review = await manager.previewNodePackage(opened.active.sessionId, { source: 'builder', package: pkg });
  assert.equal(review.canInstall, false);
  assert.ok(review.conflicts.some((item) => item.code === 'node-package-integrity-mismatch'));
});

test('A3-041/042: create, transactionally save, reopen and validate a declarative node package', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'node-package-roundtrip');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root);
  const sessionId = opened.active.sessionId;
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

  const review = await manager.previewNodePackage(sessionId, { source: 'builder', package: pkg });
  assert.equal(review.canInstall, true);
  const saved = await manager.installNodePackage(sessionId, { source: 'builder', package: pkg, expectedIntegrity: review.integrity, licenseAcknowledged: true });
  assert.equal(saved.canWrite, true, 'inert project data uses document.edit, while package.install stays unavailable');
  assert.equal(saved.packages.length, 1, JSON.stringify(saved.diagnostics));
  assert.equal(saved.entries[0].status, 'installed');
  const path = join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`);
  const original = await readFile(path);
  assert.equal(JSON.parse(original.toString('utf8')).collections[0].typeRefs[0].name, pkg.nodeTypes[0].name);
  const duplicateReview = await manager.previewNodePackage(sessionId, { source: 'builder', package: pkg });
  assert.equal(duplicateReview.canInstall, false);
  await assert.rejects(manager.installNodePackage(sessionId, { source: 'builder', package: pkg, expectedIntegrity: duplicateReview.integrity, licenseAcknowledged: true }), { code: 'node-package-already-installed' });
  assert.deepEqual(await readFile(path), original, 'an existing type version cannot be overwritten');

  const invalid = structuredClone(pkg);
  invalid.nodeTypes[0].ports[0].direction = 'inout';
  await assert.rejects(manager.previewNodePackage(sessionId, { source: 'builder', package: invalid }), { code: 'schema-invalid' });
  assert.deepEqual(await readFile(path), original, 'invalid input cannot replace the saved package');
  assert.equal((await manager.loadNodePackages(sessionId)).packages.length, 1);

  const recentId = opened.recents[0].id;
  await manager.closeActive(sessionId);
  const reopened = await manager.openRecent(recentId);
  const loaded = await manager.loadNodePackages(reopened.active.sessionId);
  assert.equal(loaded.packages[0].manifest.id, pkg.manifest.id);
  assert.equal(loaded.packages[0].nodeTypes[0].ports[0].id, pkg.nodeTypes[0].ports[0].id);
  assert.deepEqual(await readFile(path), original, 'opening the package does not rewrite its JSON bytes');
});

test('A3-041: untrusted import is reviewed before activation; malformed, unsupported and path-shaped metadata is rejected', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host: await fixtureHost(root, 'node-package-import-review') });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root), sessionId = opened.active.sessionId;
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  const malformed = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from('{ nope') }).then(() => null, (error) => error);
  assert.equal(malformed.code, 'node-package-json-invalid');
  const unsupported = structuredClone(pkg); unsupported.manifest.a3ApiVersion = '9.0.0';
  await assert.rejects(manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(unsupported)) }), { code: 'package-api-version-unsupported' });
  const invalidLicense = structuredClone(pkg); invalidLicense.manifest.license = '../secrets/license.txt';
  await assert.rejects(manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(invalidLicense)) }), { code: 'package-license-invalid' });
  const traversingId = structuredClone(pkg); traversingId.manifest.id = '../outside';
  await assert.rejects(manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(traversingId)) }));
  const embeddedPath = structuredClone(pkg); embeddedPath.path = '../../outside.json';
  await assert.rejects(manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(embeddedPath)) }));
  const review = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes });
  assert.equal(review.canInstall, true);
  assert.equal(review.action, 'install');
  assert.equal(review.typeIds[0], `${pkg.nodeTypes[0].name}@${pkg.nodeTypes[0].version}`);
  assert.match(review.destination, /^\.a3\/node-packages\//);
  assert.equal((await manager.loadNodePackages(sessionId)).entries.length, 0, 'preview neither writes nor activates package data');
  await assert.rejects(manager.installNodePackage(sessionId, { source: 'file-import', bytes, expectedIntegrity: review.integrity, licenseAcknowledged: false }), { code: 'node-package-license-review-required' });
  const changedValue = structuredClone(pkg); changedValue.nodeTypes[0].description = 'changed after review';
  const changed = Buffer.from(JSON.stringify(changedValue));
  await assert.rejects(manager.installNodePackage(sessionId, { source: 'file-import', bytes: changed, expectedIntegrity: review.integrity, licenseAcknowledged: true }), { code: 'node-package-preview-hash-changed' });
  const installed = await manager.installNodePackage(sessionId, { source: 'file-import', bytes, expectedIntegrity: review.integrity, licenseAcknowledged: true });
  assert.equal(installed.entries[0].status, 'installed');
  assert.equal(installed.entries[0].origin, 'file-import');
  const artifact = await readFile(join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`));
  const lock = JSON.parse(await readFile(join(root, lockPath), 'utf8'));
  const validate = await nodePackageLockValidator();
  assert.equal(validate(lock), true, JSON.stringify(validate.errors));
  assert.equal(lock.packages[0].integrity, (await import('node:crypto')).createHash('sha256').update(artifact).digest('hex'));
  assert.equal(lock.packages[0].origin, 'file-import');
});

test('A3-041: duplicate package ID/version and type IDs conflict without replacing existing artifact bytes', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host: await fixtureHost(root, 'node-package-duplicate') });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root), sessionId = opened.active.sessionId, pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  const review = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes });
  await manager.installNodePackage(sessionId, { source: 'file-import', bytes, expectedIntegrity: review.integrity, licenseAcknowledged: true });
  const artifactPath = join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`), original = await readFile(artifactPath);
  const duplicate = structuredClone(pkg); duplicate.nodeTypes[0].description = 'different bytes with the same package version';
  const duplicateReview = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(duplicate)) });
  assert.equal(duplicateReview.canInstall, false);
  assert.ok(duplicateReview.conflicts.some((item) => item.code === 'node-package-id-version-conflict'));
  await assert.rejects(manager.installNodePackage(sessionId, { source: 'file-import', bytes: Buffer.from(JSON.stringify(duplicate)), expectedIntegrity: duplicateReview.integrity, licenseAcknowledged: true }), { code: 'node-package-id-version-conflict' });
  assert.deepEqual(await readFile(artifactPath), original);
});

test('E6-D2: tampered artifact hash fails closed and preserves the bytes for review', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host: await fixtureHost(root, 'node-package-hash') });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root), sessionId = opened.active.sessionId, pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), review = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes });
  await manager.installNodePackage(sessionId, { source: 'file-import', bytes, expectedIntegrity: review.integrity, licenseAcknowledged: true });
  const artifactPath = join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`), before = await readFile(artifactPath);
  const tampered = structuredClone(pkg); tampered.nodeTypes[0].description = 'external content change';
  await writeFile(artifactPath, JSON.stringify(tampered, null, 2) + '\n');
  const catalog = await readDeclarativeNodePackages(root, '.a3', defaultRegistry());
  assert.equal(catalog.entries[0].status, 'integrity-mismatch');
  assert.equal(catalog.packages.length, 0);
  assert.ok(catalog.diagnostics.some((item) => item.detail === 'node-package-integrity-mismatch'));
  assert.notDeepEqual(await readFile(artifactPath), before, 'the external edit remains preserved for an explicit resolution');
});

test('A3-042: remove/reinstall preserves custom entity bytes and restores its available type', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const entityFile = join(root, '.a3', 'entities', '00000000-0000-4000-8000-000000000002.json');
  const entityRecord = JSON.parse(await readFile(entityFile, 'utf8'));
  entityRecord.type = 'community.example-nodes.sensor'; entityRecord.typeVersion = '1.0.0';
  entityRecord.properties['community.example-nodes.details'] = { retained: true };
  entityRecord.properties['community.example-nodes.sensor.model'] = 'S-1';
  entityRecord.ports.push({ id: 'community.example-nodes.sensor.signal', label: 'signal' });
  await writeFile(entityFile, JSON.stringify(entityRecord, null, 2) + '\n');
  const before = await readFile(entityFile);
  const relationsDirectory = join(root, '.a3', 'relations');
  const relationNames = (await readdir(relationsDirectory)).filter((name) => name.endsWith('.json')).sort();
  const relationBytes = await Promise.all(relationNames.map((name) => readFile(join(relationsDirectory, name))));
  const host = await fixtureHost(root, 'node-package-fallback');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root), sessionId = opened.active.sessionId;
  const serviceLease = ok(await openProjectService(root, { host, pollMs: 5000, debounceMs: 20 }));
  t.after(() => serviceLease.close());
  const records = () => serviceLease.service.state.project.snapshot.records;
  assert.ok(validateSnapshot({ records: records() }, defaultRegistry())
    .some((item) => item.detail === 'node-type-unavailable'));
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), review = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes });
  await manager.installNodePackage(sessionId, { source: 'file-import', bytes, expectedIntegrity: review.integrity, licenseAcknowledged: true });
  const installed = await manager.loadNodePackages(sessionId), entry = installed.entries[0];
  await manager.uninstallNodePackage(sessionId, pkg.manifest.id, pkg.manifest.version, entry.integrity);
  assert.deepEqual(await readFile(entityFile), before);
  assert.deepEqual(await Promise.all(relationNames.map((name) => readFile(join(relationsDirectory, name)))), relationBytes);
  const removed = await readDeclarativeNodePackages(root, '.a3');
  assert.equal(removed.entries[0].status, 'removed'); assert.equal(removed.packages.length, 0);
  assert.ok(validateSnapshot({ records: records() }, removed.registry).some((item) => item.detail === 'node-type-unavailable'));
  const reinstallReview = await manager.previewNodePackage(sessionId, { source: 'project', package: pkg, expectedIntegrity: entry.integrity });
  assert.equal(reinstallReview.canInstall, true); assert.equal(reinstallReview.action, 'reinstall');
  const reinstalled = await manager.installNodePackage(sessionId, { source: 'project', package: pkg, expectedIntegrity: reinstallReview.integrity, licenseAcknowledged: true });
  assert.equal(reinstalled.entries[0].status, 'installed');
  assert.ok((await readDeclarativeNodePackages(root, '.a3')).registry.nodeTypes.some((type) => type.name === pkg.nodeTypes[0].name));
  assert.deepEqual(await readFile(entityFile), before);
  assert.deepEqual(await Promise.all(relationNames.map((name) => readFile(join(relationsDirectory, name)))), relationBytes);
});

test('A3-041: a failed two-file install is rolled back by the journal on reopen', windows, async (t) => {
  const { root } = await scratch(t), host = await fixtureHost(root, 'node-package-rollback');
  let armed = true;
  const lease = ok(await openProjectService(root, { host, pollMs: 5000, debounceMs: 20,
    fault: (phase, event) => { if (armed && phase === 'after-install' && event.index === 0) { armed = false; throw new Error('package install interruption'); } } }));
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')), bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  const review = ok(await lease.service.previewNodePackage({ source: 'file-import', bytes }));
  const plan = ok(await lease.service.prepareImportedNodePackage('81000000-0000-4000-8000-000000000001', bytes, review.integrity, true));
  const interrupted = await lease.service.commit(plan);
  assert.equal(interrupted.ok, false); assert.equal(interrupted.recoveryRequired, true);
  await lease.close();
  const recovered = ok(await openProjectService(root, { host, pollMs: 5000, debounceMs: 20 }));
  t.after(() => recovered.close());
  assert.equal((await readDeclarativeNodePackages(root, '.a3')).packages.length, 0);
  await assert.rejects(readFile(join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, lockPath)), { code: 'ENOENT' });
});

test('A3-041: project-read profile can preview packages but cannot install a type', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const host = await fixtureHost(root, 'node-package-read-only', 'consultar');
  const manager = new LocalProjectManager({ stateDirectory: join(tempRoot, 'catalog'), host });
  t.after(() => manager.dispose());
  const opened = await manager.openFolder(root);
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const state = await manager.loadNodePackages(opened.active.sessionId);
  assert.equal(state.canWrite, false);
  const review = await manager.previewNodePackage(opened.active.sessionId, { source: 'builder', package: pkg });
  assert.equal(review.canInstall, true, 'read-only review can show declared IDs and conflicts without writing');
  await assert.rejects(manager.installNodePackage(opened.active.sessionId, { source: 'builder', package: pkg, expectedIntegrity: review.integrity, licenseAcknowledged: true }), { code: 'permission-denied' });
  await assert.rejects(readFile(join(root, '.a3', 'node-packages', `${pkg.manifest.id}--${pkg.manifest.version}.json`)), { code: 'ENOENT' });
});

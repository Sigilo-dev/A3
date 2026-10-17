import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalProjectManager, canonicalNodePackageBytes, decodeNodePackageBytes, readDeclarativeNodePackages } from '../dist/index.js';
import { addDeclarativeNodePackage, c4Category, defaultRegistry, isIotComponent } from '@a3/domain';
import { fixtureHost, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
const sampleRoot = fileURLToPath(new URL('../../../fixtures/e6/extensions/', import.meta.url));
const entityDirectory = join('.a3', 'entities');
const relationDirectory = join('.a3', 'relations');
async function isolateProjectIdentity(root) {
  const path = join(root, 'a3.project.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.projectId = randomUUID();
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
test('E6-F2/A3-041/042: sample node packs install in clean projects, export, and retire without changing node or relation bytes', windows, async (t) => {
  for (const name of ['c4-service-node.json', 'iot-bme280-reference.json']) {
    const first = await scratch(t);
    await isolateProjectIdentity(first.root);
    const bytes = await readFile(join(sampleRoot, name));
    const entityNames = (await readdir(join(first.root, entityDirectory))).filter((file) => file.endsWith('.json')).sort();
    const entityBytes = await Promise.all(entityNames.map((file) => readFile(join(first.root, entityDirectory, file))));
    const relationNames = (await readdir(join(first.root, relationDirectory))).filter((file) => file.endsWith('.json')).sort();
    const relationBytes = await Promise.all(relationNames.map((file) => readFile(join(first.root, relationDirectory, file))));
    const manager = new LocalProjectManager({ stateDirectory: join(first.tempRoot, 'manager-one'), host: await fixtureHost(first.root, `e6-samples-${name}`) });
    t.after(() => manager.dispose());
    const sessionId = (await manager.openFolder(first.root)).active.sessionId;
    const review = await manager.previewNodePackage(sessionId, { source: 'file-import', bytes });
    assert.equal(review.canInstall, true, `${name}: ${JSON.stringify(review.conflicts)}`);
    assert.equal(review.license, 'MIT'); assert.equal(review.a3ApiVersion, '1.0.0'); assert.equal(review.changesExistingInstances, false);
    const installed = await manager.installNodePackage(sessionId, { source: 'file-import', bytes,
      expectedIntegrity: review.integrity, licenseAcknowledged: true });
    const entry = installed.entries.find(({ package: pkg }) => pkg.manifest.id === review.package.manifest.id);
    assert.equal(entry.status, 'installed');
    const packageBytes = canonicalNodePackageBytes(entry.package);
    assert.deepEqual(decodeNodePackageBytes(packageBytes).package, entry.package, 'the canonical export round-trips through the package decoder');

    const merged = addDeclarativeNodePackage(defaultRegistry(), entry.package);
    assert.deepEqual(merged.diagnostics, []);
    if (name === 'c4-service-node.json') assert.equal(c4Category({ type: entry.package.nodeTypes[0].name, typeVersion: '1.0.0' }, merged.registry), 'component');
    else assert.equal(isIotComponent({ type: entry.package.nodeTypes[0].name, typeVersion: '1.0.0', properties: {}, ports: [] }), false,
      'the community reference card does not claim canonical electrical semantics');

    await manager.uninstallNodePackage(sessionId, entry.package.manifest.id, entry.package.manifest.version, entry.integrity);
    const retiredCatalog = await readDeclarativeNodePackages(first.root, '.a3', defaultRegistry());
    assert.equal(retiredCatalog.packages.length, 0);
    assert.equal(retiredCatalog.entries[0].status, 'removed');
    assert.ok(retiredCatalog.registry.nodeTypes.every(({ name: typeName }) => typeName !== entry.package.nodeTypes[0].name));
    for (const [index, file] of entityNames.entries()) assert.deepEqual(await readFile(join(first.root, entityDirectory, file)), entityBytes[index], `${file} stays byte-for-byte intact`);
    assert.deepEqual(await Promise.all(relationNames.map((file) => readFile(join(first.root, relationDirectory, file)))), relationBytes,
      'relation IDs and endpoints stay byte-for-byte intact');

    const second = await scratch(t);
    await isolateProjectIdentity(second.root);
    const secondManager = new LocalProjectManager({ stateDirectory: join(second.tempRoot, 'manager-two'), host: await fixtureHost(second.root, `e6-samples-import-${name}`) });
    t.after(() => secondManager.dispose());
    const secondSession = (await secondManager.openFolder(second.root)).active.sessionId;
    const exportReview = await secondManager.previewNodePackage(secondSession, { source: 'file-import', bytes: packageBytes });
    assert.equal(exportReview.canInstall, true);
    const secondState = await secondManager.installNodePackage(secondSession, { source: 'file-import', bytes: packageBytes,
      expectedIntegrity: exportReview.integrity, licenseAcknowledged: true });
    assert.equal(secondState.packages.length, 1, 'canonical export imports into a second clean project');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { scratch, fixtureHost } from '../../../packages/project-store/test/fixture.mjs';
import { CapabilityScopedExtensionHost, ExtensionHostError, ExtensionLeaseRegistry, EXTENSION_RUNTIME_AVAILABLE, checkExtensionInvocation } from '../src/main/extension-host.ts';
import { EXTENSION_CAPABILITIES, validExtensionPath, validExtensionsRequest, validProgrammedExtension } from '../src/shared/extensions.ts';

const fixtureUrl = new URL('../../../fixtures/e6/extensions/programmed-extension.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const updateFixture = JSON.parse(await readFile(new URL('../../../fixtures/e6/extensions/programmed-extension-v1.1.json', import.meta.url), 'utf8'));
const SESSION = '81000000-0000-4000-8000-000000000001', SESSION2 = '81000000-0000-4000-8000-000000000002';
const RESOURCE = fixture.scopes['project.read'].resourceIds[0], OTHER = '81000000-0000-4000-8000-000000000003';
const bytes = (value = fixture) => Buffer.from(JSON.stringify(value));
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const windows = { skip: process.platform !== 'win32' };
async function setup(t, confirm = async () => true, lifecycleCheckpoint, leaseRegistry) {
  const { root, tempRoot } = await scratch(t), host = await fixtureHost(root, 'extension-fixture');
  let active = { sessionId: SESSION, root, projectId: host.projectId };
  const options = { stateDirectory: join(tempRoot, 'host-profile'), actor: host.authenticatedActor, broker: host.capabilities, confirm,
    lifecycleCheckpoint, leaseRegistry,
    current: async (sessionId) => { if (sessionId !== active.sessionId) throw new ExtensionHostError('EXTENSION_STALE_SESSION'); return structuredClone(active); } };
  const extensions = new CapabilityScopedExtensionHost(options); t.after(() => extensions.dispose());
  return { root, tempRoot, host, options, extensions, setActive: (value) => { active = value; },
    review: async (value = fixture) => ok(await extensions.handle({ action: 'review', sessionId: SESSION, bytes: bytes(value) })),
    register: async (value = fixture) => {
      const review = ok(await extensions.handle({ action: 'review', sessionId: SESSION, bytes: bytes(value) }));
      const state = ok(await extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true }));
      return state.extensions[0];
    } };
}

test('A3-043 programmed manifest is a separate strict profile; fixture matches schema and declared entrypoint hash', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(JSON.parse(await readFile(new URL('../../../schemas/e0/common.schema.json', import.meta.url))));
  const validate = ajv.compile(JSON.parse(await readFile(new URL('../../../schemas/e1/programmed-extension.schema.json', import.meta.url))));
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors)); assert.equal(validProgrammedExtension(fixture), true);
  assert.equal(validate(updateFixture), true, JSON.stringify(validate.errors)); assert.equal(validProgrammedExtension(updateFixture), true);
  const resource = JSON.parse(await readFile(new URL(`../../../fixtures/e0/project/.a3/resources/${RESOURCE}.json`, import.meta.url)));
  assert.equal(resource.id, RESOURCE);
  const source = await readFile(new URL('../../../fixtures/e6/extensions/malicious.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), fixture.entrypoints.main.sha256);
  for (const path of ['../escape.mjs', '/absolute.mjs', 'C:/escape.mjs', 'folder/../escape', 'folder\\escape', 'CON.js', 'x./file', '.a3/token', 'file.js:stream', '//server/share', 'x/evil?.mjs']) {
    assert.equal(validExtensionPath(path), false, path);
    const changed = structuredClone(fixture); changed.entrypoints.main.path = path; assert.equal(validProgrammedExtension(changed), false);
  }
  const unknown = structuredClone(fixture); unknown.permissions.push('shell.arbitrary'); assert.equal(validProgrammedExtension(unknown), false);
  const version = structuredClone(fixture); version.a3ApiVersion = '9.0.0'; assert.equal(validProgrammedExtension(version), false);
  const remote = structuredClone(fixture); remote.scopes['network.access'].origins = ['https://user:password@example.invalid/path']; assert.equal(validProgrammedExtension(remote), false);
  const wildcard = structuredClone(fixture); wildcard.scopes['network.access'].origins = ['https://*.example.invalid']; assert.equal(validProgrammedExtension(wildcard), false);
});

test('A3-043 manifest review has no registration side effect; apply requires native approval and exact session', windows, async (t) => {
  let approve = false; const env = await setup(t, async () => approve);
  assert.equal((await env.extensions.handle({ action: 'review', sessionId: SESSION, bytes: Buffer.from([255]) })).error.code, 'EXTENSION_MANIFEST_SYNTAX_INVALID');
  const review = await env.review(); assert.equal(review.runtimeAvailable, false);
  assert.equal(ok(await env.extensions.handle({ action: 'status', sessionId: SESSION })).extensions.length, 0);
  const denied = await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true });
  assert.equal(denied.error.code, 'EXTENSION_APPROVAL_REJECTED');
  approve = true; const entry = await env.register(); assert.equal(entry.disabled, true);
  assert.ok(entry.permissions.every((item) => !item.approved && !item.effective));
  const source = join(env.root, '.a3', 'entities', '00000000-0000-4000-8000-000000000002.json'), before = await readFile(source);
  ok(await env.extensions.handle({ action: 'remove', sessionId: SESSION, id: fixture.id, integrity: entry.integrity }));
  assert.deepEqual(await readFile(source), before, 'removal only deletes the host-local manifest registration');
});

test('A3-043 read/write/network/process approvals are independent and remain ineffective without a verified Windows sandbox', windows, async (t) => {
  const reviews = []; const env = await setup(t, async (message, detail) => { reviews.push({ message, detail }); return true; });
  let entry = await env.register();
  for (const capability of EXTENSION_CAPABILITIES) {
    const state = ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability, scope: fixture.scopes[capability] }));
    entry = state.extensions[0];
    assert.deepEqual(entry.permissions.find((item) => item.capability === capability).approved, fixture.scopes[capability]);
    assert.ok(entry.permissions.every((item) => item.effective === false));
    assert.equal(state.runtimeAvailable, false);
  }
  assert.equal(reviews.length, 5, 'registration plus one native confirmation per separate capability');
  assert.equal(EXTENSION_RUNTIME_AVAILABLE, false);
  const start = await env.extensions.handle({ action: 'start', sessionId: SESSION, id: fixture.id, integrity: entry.integrity });
  assert.equal(start.error.code, 'EXTENSION_SANDBOX_UNAVAILABLE');
});

test('A3-043 hostile manifest claims, portable policy and a Working project cannot load code or inherit privileges', windows, async (t) => {
  const env = await setup(t), outside = join(env.tempRoot, 'outside.txt'); await writeFile(outside, 'preserve');
  await writeFile(join(env.root, '.a3', 'policies.json'), JSON.stringify({ profile: 'trabajar', sandbox: true, extensions: { [fixture.id]: { approved: true, capabilities: ['*'] } } }));
  const entry = await env.register();
  const start = await env.extensions.handle({ action: 'start', sessionId: SESSION, id: fixture.id, integrity: entry.integrity });
  assert.equal(start.error.code, 'EXTENSION_SANDBOX_UNAVAILABLE'); assert.equal(await readFile(outside, 'utf8'), 'preserve');
  assert.ok(entry.permissions.every((permission) => !permission.effective && !permission.approved));
  const source = await readFile(new URL('../src/main/extension-host.ts', import.meta.url), 'utf8');
  assert.equal(/from ['"]node:(?:child_process|vm|worker_threads)['"]|\beval\s*\(|\bnew Function\s*\(|await import\s*\(/.test(source), false, 'the extension host must not contain an executable fallback');
});

test('A3-043 updates show permission/scope deltas, never retain approvals, and immutable versions cannot be replaced', windows, async (t) => {
  let approve = true; const env = await setup(t, async () => approve), original = await env.register();
  ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: original.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  const changed = structuredClone(fixture); changed.scopes['project.read'].resourceIds.push(OTHER);
  assert.equal((await env.extensions.handle({ action: 'review', sessionId: SESSION, bytes: bytes(changed) })).error.code, 'EXTENSION_IMMUTABLE_VERSION');
  changed.version = '1.1.0'; const review = await env.review(changed);
  assert.equal(review.clearsApprovals, true); assert.equal(review.changes[0].capability, 'project.read');
  approve = false; assert.equal((await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true })).error.code, 'EXTENSION_APPROVAL_REJECTED');
  const retained = ok(await env.extensions.handle({ action: 'status', sessionId: SESSION })).extensions[0];
  assert.equal(retained.integrity, original.integrity); assert.ok(retained.permissions[0].approved);
  approve = true; const updated = await env.register(changed);
  assert.equal(updated.manifest.version, '1.1.0'); assert.ok(updated.permissions.every((item) => !item.approved));
  assert.equal((await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: original.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] })).error.code, 'EXTENSION_IDENTITY_CHANGED');
});

test('E6-E2 update validates compatibility, license and scope consent, stages the manifest, then keeps an explicit rollback version', windows, async (t) => {
  const confirmations = [], phases = [], env = await setup(t, async (message, detail) => { confirmations.push({ message, detail }); return true; }, (phase) => { phases.push(phase); });
  const original = await env.register();
  phases.length = 0;
  ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: original.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  const source = join(env.root, '.a3', 'entities', '00000000-0000-4000-8000-000000000002.json'), sourceBefore = await readFile(source);
  assert.equal(validProgrammedExtension(updateFixture), true);
  const permissionRemoved = structuredClone(updateFixture); permissionRemoved.permissions = permissionRemoved.permissions.filter((permission) => permission !== 'network.access'); delete permissionRemoved.scopes['network.access'];
  const permissionReview = await env.review(permissionRemoved);
  assert.equal(permissionReview.changes.some((change) => change.capability === 'network.access' && change.before && !change.after), true);
  const updateReview = await env.review(updateFixture);
  assert.equal(updateReview.previousVersion, '1.0.0'); assert.equal(updateReview.compatible, true); assert.equal(updateReview.license, 'Apache-2.0');
  assert.equal(updateReview.changes.some((change) => change.capability === 'project.read'), true);
  const needsLicenseReview = await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: updateReview.token, licenseAcknowledged: false });
  assert.equal(needsLicenseReview.error.code, 'EXTENSION_LICENSE_REVIEW_REQUIRED');

  const approvedReview = await env.review(updateFixture);
  const updated = ok(await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: approvedReview.token, licenseAcknowledged: true }));
  assert.deepEqual(phases, ['manifest-staged', 'before-activate']);
  assert.equal(updated.extensions[0].manifest.version, '1.1.0'); assert.equal(updated.extensions[0].disabled, true);
  assert.equal(updated.extensions[0].rollbackVersion, '1.0.0'); assert.ok(updated.extensions[0].permissions.every((permission) => !permission.approved && !permission.effective));
  assert.match(confirmations.at(-1).detail, /Apache-2\.0/); assert.match(confirmations.at(-1).detail, /project\.read/);
  assert.deepEqual(await readFile(source), sourceBefore, 'updating plugin metadata cannot mutate project entities or fallback data');

  const rolledBack = ok(await env.extensions.handle({ action: 'rollback', sessionId: SESSION, id: fixture.id, integrity: updated.extensions[0].integrity }));
  assert.equal(rolledBack.extensions[0].manifest.version, '1.0.0'); assert.equal(rolledBack.extensions[0].rollbackVersion, '1.1.0');
  assert.ok(rolledBack.extensions[0].permissions.every((permission) => !permission.approved && !permission.effective));
  assert.deepEqual(await readFile(source), sourceBefore, 'rollback preserves project files and leaves the extension deactivated');

  const downgrade = structuredClone(fixture); downgrade.version = '0.9.0';
  assert.equal((await env.extensions.handle({ action: 'review', sessionId: SESSION, bytes: bytes(downgrade) })).error.code, 'EXTENSION_VERSION_NOT_NEWER');
  const incompatible = structuredClone(updateFixture); incompatible.a3ApiVersion = '2.0.0';
  assert.equal((await env.extensions.handle({ action: 'review', sessionId: SESSION, bytes: bytes(incompatible) })).error.code, 'EXTENSION_MANIFEST_INVALID');
});

test('E6-E2 failed staging activation rolls back to the previous local record without losing approvals or data', windows, async (t) => {
  let failureMode = 'none', env;
  env = await setup(t, async () => true, async (phase) => {
    if (failureMode === 'tamper' && phase === 'manifest-staged') {
      const stagingRoot = join(env.options.stateDirectory, 'extension-host', 'staging'), projectStages = await readdir(stagingRoot), files = await readdir(join(stagingRoot, projectStages[0]));
      await writeFile(join(stagingRoot, projectStages[0], files[0]), 'changed after staging');
    }
    if (failureMode === 'activate' && phase === 'before-activate') throw new Error('fixture interrupted activation');
  });
  const original = await env.register();
  await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: original.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] });
  const projectDataPath = join(env.root, '.a3', 'entities', '00000000-0000-4000-8000-000000000002.json'), projectDataBefore = await readFile(projectDataPath);
  const directory = join(env.options.stateDirectory, 'extension-host'), statePath = join(directory, (await readdir(directory)).find((name) => name.endsWith('.json')));
  const beforeState = await readFile(statePath), integrityReview = await env.review(updateFixture); failureMode = 'tamper';
  const integrityFailure = await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: integrityReview.token, licenseAcknowledged: true });
  assert.equal(integrityFailure.error.code, 'EXTENSION_STAGING_INTEGRITY_FAILED'); assert.deepEqual(await readFile(statePath), beforeState);
  failureMode = 'activate'; const review = await env.review(updateFixture);
  const result = await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true });
  assert.equal(result.error.code, 'EXTENSION_UPDATE_ROLLED_BACK');
  assert.deepEqual(await readFile(statePath), beforeState);
  const status = ok(await env.extensions.handle({ action: 'status', sessionId: SESSION }));
  assert.equal(status.extensions[0].manifest.version, '1.0.0'); assert.ok(status.extensions[0].permissions[0].approved);
  assert.deepEqual(await readFile(projectDataPath), projectDataBefore);
  const stagingRoot = join(directory, 'staging'), projectStages = await readdir(stagingRoot);
  assert.equal((await readdir(join(stagingRoot, projectStages[0]))).length, 0, 'failed candidate is removed from staging');
});

test('E6-E2 revoke synchronously invalidates an active extension lease and requests termination', windows, async (t) => {
  const leases = new ExtensionLeaseRegistry(); let terminated = 0;
  const env = await setup(t, async () => true, undefined, leases), entry = await env.register();
  const grant = ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  const token = leases.track(env.root, env.host.projectId, fixture.id, () => { terminated++; });
  assert.equal(leases.accepts(token), true);
  const revoked = ok(await env.extensions.handle({ action: 'revoke', sessionId: SESSION, id: fixture.id, integrity: grant.extensions[0].integrity, capability: 'project.read' }));
  assert.ok(!revoked.extensions[0].permissions.find((permission) => permission.capability === 'project.read').approved);
  assert.equal(leases.accepts(token), false); await leases.settle(); assert.equal(terminated, 1);
});

test('E6-E2 disable preserves the project fallback and extension record while clearing grants and active leases', windows, async (t) => {
  const leases = new ExtensionLeaseRegistry(); let terminated = 0;
  const env = await setup(t, async () => true, undefined, leases), entry = await env.register();
  const granted = ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  const projectDataPath = join(env.root, '.a3', 'entities', '00000000-0000-4000-8000-000000000002.json'), projectDataBefore = await readFile(projectDataPath);
  const token = leases.track(env.root, env.host.projectId, fixture.id, () => { terminated++; });
  const disabled = ok(await env.extensions.handle({ action: 'disable', sessionId: SESSION, id: fixture.id, integrity: granted.extensions[0].integrity }));
  assert.equal(disabled.extensions.length, 1); assert.equal(disabled.extensions[0].disabled, true);
  assert.ok(disabled.extensions[0].permissions.every((permission) => !permission.approved && !permission.effective));
  assert.equal(leases.accepts(token), false); await leases.settle(); assert.equal(terminated, 1);
  assert.deepEqual(await readFile(projectDataPath), projectDataBefore);
});

test('E6-E2 reads an E6-E1 local registry and upgrades it only when the next reviewed write commits', windows, async (t) => {
  const env = await setup(t), original = await env.register(), directory = join(env.options.stateDirectory, 'extension-host');
  const statePath = join(directory, (await readdir(directory)).find((name) => name.endsWith('.json'))), legacy = JSON.parse(await readFile(statePath, 'utf8'));
  legacy.schemaVersion = '1.0.0'; delete legacy.history; await writeFile(statePath, JSON.stringify(legacy, null, 2) + '\n');
  const readOnly = ok(await env.extensions.handle({ action: 'status', sessionId: SESSION }));
  assert.equal(readOnly.extensions[0].integrity, original.integrity); assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, '1.0.0');
  const review = await env.review(updateFixture);
  ok(await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true }));
  const migrated = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(migrated.schemaVersion, '1.1.0'); assert.equal(migrated.history[0].manifest.version, '1.0.0');
});

test('A3-043 resource ID scopes reject cross-project, raw filesystem, undeclared capabilities and unapproved writes', () => {
  const approvals = { 'project.read': fixture.scopes['project.read'] }, projectId = OTHER;
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId, capability: 'project.read', target: RESOURCE }).ok, true);
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId: RESOURCE, capability: 'project.read', target: RESOURCE }).code, 'EXTENSION_CROSS_PROJECT');
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId, capability: 'project.read', target: '../outside' }).code, 'EXTENSION_OUTSIDE_SCOPE');
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId, capability: 'project.read', target: RESOURCE, path: 'C:/secret' }).code, 'EXTENSION_INVALID_INVOCATION');
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId, capability: 'document.edit', target: RESOURCE }).code, 'EXTENSION_PERMISSION_NOT_GRANTED');
  assert.equal(checkExtensionInvocation(projectId, fixture, approvals, { projectId, capability: 'git.push', target: RESOURCE }).code, 'EXTENSION_PERMISSION_NOT_DECLARED');
});

test('A3-043 a separate narrow approval cannot cover another declared resource or expand beyond the manifest', windows, async (t) => {
  const env = await setup(t), manifest = structuredClone(fixture); manifest.scopes['project.read'].resourceIds.push(OTHER);
  const entry = await env.register(manifest), capability = 'project.read', scope = { resourceIds: [RESOURCE] };
  const state = ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: manifest.id, integrity: entry.integrity, capability, scope }));
  const approvals = { [capability]: state.extensions[0].permissions[0].approved };
  assert.equal(checkExtensionInvocation(env.host.projectId, manifest, approvals, { projectId: env.host.projectId, capability, target: OTHER }).code, 'EXTENSION_PERMISSION_NOT_GRANTED');
  const request = await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: manifest.id, integrity: entry.integrity, capability, scope: { resourceIds: [SESSION2] } });
  assert.equal(request.error.code, 'EXTENSION_OUTSIDE_SCOPE');
});

test('A3-043 restarting the host restores only inert metadata and approvals, never an executing extension', windows, async (t) => {
  const env = await setup(t), entry = await env.register();
  ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  await env.extensions.dispose();
  const reopened = new CapabilityScopedExtensionHost(env.options); t.after(() => reopened.dispose());
  const state = ok(await reopened.handle({ action: 'status', sessionId: SESSION }));
  assert.equal(state.extensions[0].disabled, true); assert.ok(state.extensions[0].permissions[0].approved); assert.equal(state.extensions[0].permissions[0].effective, false);
  assert.equal((await reopened.handle({ action: 'start', sessionId: SESSION, id: fixture.id, integrity: entry.integrity })).error.code, 'EXTENSION_SANDBOX_UNAVAILABLE');
});

test('A3-043 a broker revocation during native approval invalidates the pending grant before it is persisted', windows, async (t) => {
  let revokeDuringApproval = false, env;
  env = await setup(t, async () => {
    if (revokeDuringApproval) await env.host.capabilities.revoke({ root: env.root, projectId: env.host.projectId, capability: 'document.edit' });
    return true;
  });
  const entry = await env.register(); revokeDuringApproval = true;
  const result = await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] });
  assert.equal(result.error.code, 'EXTENSION_REVIEW_STALE');
  const state = ok(await env.extensions.handle({ action: 'status', sessionId: SESSION })); assert.ok(!state.extensions[0].permissions[0].approved);
});

test('A3-043 a clone with the same UUID has no local registrations/grants and cannot consume another project review', windows, async (t) => {
  const env = await setup(t), entry = await env.register();
  ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability: 'project.read', scope: fixture.scopes['project.read'] }));
  const review = await env.review(updateFixture), cloneRoot = join(env.tempRoot, 'clone'); await cp(env.root, cloneRoot, { recursive: true });
  const cloneHost = await fixtureHost(cloneRoot, env.host.authenticatedActor.id);
  await env.host.capabilities.setProfile({ root: cloneRoot, projectId: cloneHost.projectId, profile: 'trabajar' });
  env.setActive({ root: cloneRoot, projectId: cloneHost.projectId, sessionId: SESSION2 });
  const state = ok(await env.extensions.handle({ action: 'status', sessionId: SESSION2 })); assert.equal(state.extensions.length, 0);
  assert.equal((await env.extensions.handle({ action: 'apply', sessionId: SESSION2, token: review.token, licenseAcknowledged: true })).error.code, 'EXTENSION_REVIEW_STALE');
  assert.equal((await env.extensions.handle({ action: 'status', sessionId: SESSION })).error.code, 'EXTENSION_STALE_SESSION');
});

test('A3-043 revocation affects the next scope decision; broker revocation invalidates outstanding reviews', windows, async (t) => {
  const env = await setup(t), entry = await env.register(), capability = 'project.read';
  const approved = ok(await env.extensions.handle({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability, scope: fixture.scopes[capability] }));
  assert.ok(approved.extensions[0].permissions[0].approved);
  const revoked = ok(await env.extensions.handle({ action: 'revoke', sessionId: SESSION, id: fixture.id, integrity: entry.integrity, capability }));
  assert.ok(!revoked.extensions[0].permissions[0].approved);
  const review = await env.review(updateFixture); await env.host.capabilities.revoke({ root: env.root, projectId: env.host.projectId, capability: 'document.edit' });
  assert.equal((await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true })).error.code, 'EXTENSION_REVIEW_STALE');
});

test('A3-043 lease invalidation is synchronous, root/project scoped, and remains revoked if a future termination adapter fails', async () => {
  const leases = new ExtensionLeaseRegistry(); let calls = 0;
  const token = leases.track('C:/one', OTHER, fixture.id, async () => { calls++; throw new Error('fixture termination failure'); });
  const foreign = leases.track('C:/two', OTHER, fixture.id, () => { calls++; });
  leases.invalidate('c:/ONE', OTHER, fixture.id); assert.equal(leases.accepts(token), false); assert.equal(leases.accepts(foreign), true);
  await leases.settle(); assert.equal(calls, 1); assert.equal(leases.terminationFailures, 1);
  leases.invalidate(); await leases.settle(); assert.equal(calls, 2);
});

test('A3-043 junction/moved roots are unavailable and never become empty files', windows, async (t) => {
  const env = await setup(t), link = join(env.tempRoot, 'junction'); await symlink(env.root, link, 'junction');
  env.setActive({ root: link, projectId: env.host.projectId, sessionId: SESSION });
  assert.equal((await env.extensions.handle({ action: 'status', sessionId: SESSION })).error.code, 'EXTENSION_ROOT_UNAVAILABLE');
  env.setActive({ root: env.root, projectId: env.host.projectId, sessionId: SESSION });
  await rename(env.root, join(env.tempRoot, 'moved-project'));
  assert.equal((await env.extensions.handle({ action: 'status', sessionId: SESSION })).error.code, 'EXTENSION_ROOT_UNAVAILABLE');
});

test('A3-043 switching root identity during approval rejects the write and preserves the original project', windows, async (t) => {
  let replaceRoot = false, env;
  env = await setup(t, async () => {
    if (replaceRoot) { await rename(env.root, join(env.tempRoot, 'old-root')); await mkdir(env.root); }
    return true;
  });
  const review = await env.review(); replaceRoot = true;
  assert.equal((await env.extensions.handle({ action: 'apply', sessionId: SESSION, token: review.token, licenseAcknowledged: true })).error.code, 'EXTENSION_REVIEW_STALE');
  assert.ok((await readFile(join(env.tempRoot, 'old-root', 'a3.project.json'))).length > 0);
});

test('A3-043 corrupt local state fails closed without rewriting; audit excludes source, paths, scopes and arbitrary manifest content', windows, async (t) => {
  const env = await setup(t); await env.register();
  const directory = join(env.options.stateDirectory, 'extension-host'), audit = await readFile(join(directory, 'audit.ndjson'), 'utf8');
  assert.doesNotMatch(audit, /malicious\.mjs|example\.invalid|sandbox|entrypoints|C:\\|resourceIds/);
  const path = join(directory, (await readdir(directory)).find((name) => name.endsWith('.json')));
  const corrupt = Buffer.from('{ interrupted'); await writeFile(path, corrupt);
  assert.equal((await env.extensions.handle({ action: 'status', sessionId: SESSION })).error.code, 'EXTENSION_LOCAL_STATE_INVALID');
  assert.deepEqual(await readFile(path), corrupt);
});

test('A3-043 UI bridge accepts configuration only, with no invocation, caller actor/root or arbitrary code escape hatch', () => {
  assert.equal(validExtensionsRequest({ action: 'status', sessionId: SESSION }), true);
  assert.equal(validExtensionsRequest({ action: 'apply', sessionId: SESSION, token: SESSION2, licenseAcknowledged: true }), true);
  assert.equal(validExtensionsRequest({ action: 'apply', sessionId: SESSION, token: SESSION2 }), false);
  assert.equal(validExtensionsRequest({ action: 'rollback', sessionId: SESSION, id: fixture.id, integrity: 'a'.repeat(64) }), true);
  for (const extra of [{ root: 'C:/outside' }, { actor: { kind: 'user' } }, { projectId: OTHER }, { sandbox: true }]) {
    assert.equal(validExtensionsRequest({ action: 'status', sessionId: SESSION, ...extra }), false);
  }
  assert.equal(validExtensionsRequest({ action: 'invoke', sessionId: SESSION, command: 'shell' }), false);
  assert.equal(validExtensionsRequest({ action: 'grant', sessionId: SESSION, id: fixture.id, integrity: 'a'.repeat(64), capability: 'project.read', scope: { resourceIds: [RESOURCE], path: '../escape' } }), false);
});

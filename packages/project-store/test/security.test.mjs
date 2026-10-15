import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CAPABILITIES, createProjectCapabilityBroker, parseSharedPolicyRequest } from '../dist/index.js';
import { openProjectService } from '../dist/index.js';
import { fixtureHost, id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };

const capability = (result, expected) => {
  assert.equal(result.allowed, expected, JSON.stringify(result));
  if (!expected) assert.ok(result.missingCapability, JSON.stringify(result));
};
async function brokerFor(root, actor = { kind: 'agent', id: 'agent-1' }, confirm = ({ operation }) => operation.startsWith('policy.')) {
  const project = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  const broker = createProjectCapabilityBroker({ stateDirectory: join(resolve(root, '..'), 'a3-host-data'), authenticatedActor: actor, confirmUserAction: confirm });
  return { broker, projectId: project.projectId, actor };
}

test('profiles separate proposal from apply, reject agent impersonation, and default deny destructive or unavailable capabilities', async (t) => {
  const { root } = await scratch(t);
  const { broker, projectId, actor } = await brokerFor(root);
  await broker.setProfile({ root, projectId }); // Proponer es el perfil inicial.
  capability(broker.authorizeAccess({ actor, root, projectId, operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] }), true);
  capability(broker.authorizeAccess({ actor, root, projectId, operation: 'write', paths: ['.a3/entities/example.json'], refs: [], resources: [], requiredCapabilities: ['document.edit'], stage: 'prepare' }), true);
  const update = { actor, projectId, operationId: '80000000-0000-4000-8000-000000000001', command: 'a3.core.update-entity', entityIds: [],
    refs: [{ kind: 'entity', id: '00000000-0000-4000-8000-000000000002' }], contentEffects: [], registryWrite: false, changes: [], nodeTypeChanges: [] };
  capability(broker.authorizeDomain(root, actor, update), true);
  const apply = await broker.authorizeApply(root, actor, update);
  assert.equal(apply.allowed, false); assert.equal(apply.missingCapability, 'document.edit');
  assert.equal((await broker.authorizeCapabilities(root, { kind: 'user', id: 'forged' }, projectId, ['document.edit'], 'forged', 'prepare')).reason, 'actor-mismatch');

  await broker.setGrant({ root, projectId, capability: 'process.run', mode: 'direct' });
  const process = await broker.authorizeCapabilities(root, actor, projectId, ['process.run'], 'process.run', 'apply');
  assert.equal(process.allowed, false); assert.equal(process.reason, 'capability-unavailable');
  const destructive = await broker.authorizeCapabilities(root, actor, projectId, ['delete'], 'domain.delete', 'apply');
  assert.equal(destructive.allowed, false); assert.equal(destructive.missingCapability, 'delete');

  await broker.setProfile({ root, projectId, profile: 'consultar' });
  const readOnly = broker.authorizeAccess({ actor, root, projectId, operation: 'write', paths: ['.a3/entities/example.json'], refs: [], resources: [], requiredCapabilities: ['document.edit'], stage: 'prepare' });
  assert.equal(readOnly.allowed, false); assert.equal(readOnly.missingCapability, 'document.edit');
  assert.deepEqual(CAPABILITIES.includes('git.push'), true);
});

test('shared policies remain inert and a cloned project cannot inherit or expand local grants', async (t) => {
  const { root, tempRoot } = await scratch(t);
  const { broker, projectId, actor } = await brokerFor(root);
  await broker.setProfile({ root, projectId, profile: 'trabajar' });
  const policy = { schemaVersion: '1.0.0', requests: [
    { capability: 'process.run', mode: 'direct' }, { capability: 'network.access', mode: 'direct' }, { capability: 'delete', mode: 'direct' }
  ], secret: 'do-not-log-this-secret' };
  await writeFile(join(root, '.a3', 'policies.json'), JSON.stringify(policy));
  assert.deepEqual(parseSharedPolicyRequest(await readFile(join(root, '.a3', 'policies.json'), 'utf8')), { schemaVersion: '1.0.0', requests: policy.requests });
  assert.equal((await broker.authorizeCapabilities(root, actor, projectId, ['process.run'], 'inert-policy', 'apply')).reason, 'capability-unavailable');
  assert.equal((await broker.authorizeCapabilities(root, actor, projectId, ['delete'], 'inert-policy', 'apply')).allowed, false);
  capability(await broker.authorizeCapabilities(root, actor, projectId, ['document.edit'], 'granted-edit', 'apply'), true);
  await broker.authorizeCapabilities(root, actor, projectId, ['document.edit'], 'do-not-log-this-secret', 'apply');

  const clone = join(tempRoot, 'cloned-project');
  await cp(root, clone, { recursive: true });
  const cloned = broker.authorizeAccess({ actor, root: clone, operation: 'open-project', paths: ['a3.project.json'], refs: [], resources: [] });
  assert.equal(cloned.allowed, false); assert.equal(cloned.missingCapability, 'project.read');

  await broker.revoke({ root, projectId, capability: 'document.edit' });
  const afterRevoke = await broker.authorizeCapabilities(root, actor, projectId, ['document.edit'], 'after-revoke', 'apply');
  assert.equal(afterRevoke.allowed, false); assert.equal(afterRevoke.missingCapability, 'document.edit');
  const audit = await readFile(join(tempRoot, 'a3-host-data', 'capability-audit.ndjson'), 'utf8');
  assert.ok(audit.includes('"outcome":"deny"'));
  assert.ok(audit.includes('"actorKind":"agent"'));
  assert.equal(audit.includes('direct grant secret'), false);
  assert.equal(audit.includes('do-not-log-this-secret'), false);
  assert.equal(audit.includes(join(root, '.a3', 'policies.json')), false);
});

test('capability categories stay independent in Trabajar and Personalizado', async (t) => {
  const { root } = await scratch(t);
  const { broker, projectId, actor } = await brokerFor(root);
  await broker.setProfile({ root, projectId, profile: 'trabajar' });
  capability(await broker.authorizeCapabilities(root, actor, projectId, ['document.edit'], 'a3.core.update-entity', 'apply'), true);
  capability(await broker.authorizeCapabilities(root, actor, projectId, ['diagram.edit'], 'a3.core.move-placement', 'apply'), true);
  capability(await broker.authorizeCapabilities(root, actor, projectId, ['task.edit'], 'a3.core.set-collection-members', 'apply'), true);
  for (const cap of ['delete', 'mount.read', 'network.access', 'package.install', 'export', 'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'git.branch', 'git.restore']) {
    const result = await broker.authorizeCapabilities(root, actor, projectId, [cap], `probe.${cap}`, 'apply');
    assert.equal(result.allowed, false, `${cap} must stay independent`);
    assert.equal(result.missingCapability, cap);
  }

  await broker.setProfile({ root, projectId, profile: 'personalizado' });
  await broker.setGrant({ root, projectId, capability: 'diagram.edit', mode: 'direct' });
  capability(await broker.authorizeCapabilities(root, actor, projectId, ['diagram.edit'], 'custom.diagram', 'apply'), true);
  const unrelated = await broker.authorizeCapabilities(root, actor, projectId, ['document.edit'], 'custom.document', 'apply');
  assert.equal(unrelated.allowed, false); assert.equal(unrelated.missingCapability, 'document.edit');
});

test('the project service exposes no callback-based permission bypass', async (t) => {
  const { root } = await scratch(t);
  const host = await fixtureHost(root);
  assert.equal(Object.hasOwn(host, 'authorizeAccess'), false);
  assert.equal(Object.hasOwn(host, 'domain'), false);
  assert.equal(typeof host.capabilities.authorizeAccess, 'function');
  assert.equal(typeof host.capabilities.authorizeApply, 'function');
  const forged = await openProjectService(root, { host: { authenticatedActor: host.authenticatedActor, capabilities: {
    authorizeAccess: () => ({ allowed: true, capability: 'project.read', reason: 'granted', mode: 'direct' })
  } } });
  assert.equal(forged.ok, false);
  assert.equal(forged.diagnostics[0].detail, 'capability-broker-required');
  assert.equal(forged.diagnostics[0].missingCapability, 'project.read');
});

test('an agent can prepare under Proponer but cannot apply without a host approval', windows, async (t) => {
  const { root } = await scratch(t);
  const actor = { kind: 'agent', id: 'agent-1' };
  const project = JSON.parse(await readFile(join(root, 'a3.project.json'), 'utf8'));
  let approveEdits = false;
  const capabilities = createProjectCapabilityBroker({ stateDirectory: join(resolve(root, '..'), 'a3-host-data'), authenticatedActor: actor,
    confirmUserAction: ({ operation }) => operation.startsWith('policy.') || approveEdits });
  await capabilities.setProfile({ root, projectId: project.projectId, profile: 'proponer' });
  const host = { authenticatedActor: actor, capabilities };
  const opened = await openProjectService(root, { host, pollMs: 5000 });
  assert.equal(opened.ok, true, JSON.stringify(opened.diagnostics));
  t.after(() => opened.value.close());
  const service = opened.value.service;
  const resource = service.state.project.snapshot.records.find((record) => record.kind === 'resource').value;
  const source = await service.openResource(resource.id);
  assert.equal(source.ok, true, JSON.stringify(source.diagnostics));
  const prepare = (operationId) => service.prepareResourceWrite({ operationId, resourceId: source.value.resourceId,
    expectedRevision: source.value.revision, expectedHash: source.value.sha256, bytes: Buffer.from('agent proposal') });
  const plan = await prepare(id(951));
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const denied = await service.commit(plan.value);
  assert.equal(denied.ok, false); assert.equal(denied.diagnostics[0].missingCapability, 'document.edit');

  approveEdits = true;
  const approvedPlan = await prepare(id(952));
  assert.equal(approvedPlan.ok, true, JSON.stringify(approvedPlan.diagnostics));
  const applied = await service.commit(approvedPlan.value);
  assert.equal(applied.ok, true, JSON.stringify(applied.diagnostics));
  await capabilities.revoke({ root, projectId: project.projectId, capability: 'project.read' });
  const hidden = service.state;
  assert.equal(hidden.project.snapshot.records.length, 0);
  assert.equal(hidden.project.diagnostics[0].missingCapability, 'project.read');
  const readAfterRevoke = await service.openResource(resource.id);
  assert.equal(readAfterRevoke.ok, false); assert.equal(readAfterRevoke.diagnostics[0].missingCapability, 'project.read');
});

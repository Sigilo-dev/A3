import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AGENT_PROCESS_ISOLATION_AVAILABLE, AGENT_PROCESS_LIMITS, ActiveAgentProcessRegistry, AgentProcessOutputLimit,
  authorizeAgentProcess, captureAgentExecutionRoot, createAgentProcessDeadline, createProjectCapabilityBroker, validateAgentProcessIntent } from '../dist/index.js';
import { id, scratch } from './fixture.mjs';

const windows = { skip: process.platform !== 'win32' };
function request(patch = {}) {
  return { executableId: 'npm', arguments: ['test'], rootId: 'workspace', cwdRelative: 'src', environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
    wallTimeMs: 15_000, cpuTimeMs: 10_000, maxOutputBytes: 64 * 1024, maxMemoryMb: 256, maxProcesses: 4, network: false, ...patch };
}

test('agent process cwd is confined to an approved root and reparse points are rejected immediately before launch', windows, async (t) => {
  const { root, tempRoot } = await scratch(t);
  const outside = join(tempRoot, 'outside-process-root');
  await mkdir(outside, { recursive: true }); await mkdir(join(root, 'src'), { recursive: true });
  const approved = await captureAgentExecutionRoot('workspace', root);
  assert.deepEqual((await validateAgentProcessIntent(request(), [approved])).ok, true);
  assert.equal((await validateAgentProcessIntent(request({ cwdRelative: '..\\outside-process-root' }), [approved])).code, 'PROCESS_PATH_OUTSIDE_ROOT');
  assert.equal((await validateAgentProcessIntent(request({ cwdRelative: outside }), [approved])).code, 'PROCESS_PATH_OUTSIDE_ROOT');
  assert.equal((await validateAgentProcessIntent(request({ rootId: 'unapproved' }), [approved])).code, 'PROCESS_PATH_OUTSIDE_ROOT');

  try { await symlink(outside, join(root, 'junction'), 'junction'); }
  catch { t.skip('Windows no permitió crear un junction en el directorio temporal de esta cuenta.'); return; }
  assert.equal((await validateAgentProcessIntent(request({ cwdRelative: 'junction' }), [approved])).code, 'PROCESS_REPARSE_POINT');
});

test('agent process requests enforce time, CPU, output, memory, count, network and environment bounds', async (t) => {
  const { root } = await scratch(t); await mkdir(join(root, 'src'), { recursive: true });
  const approved = await captureAgentExecutionRoot('workspace', root), roots = [approved];
  for (const patch of [
    { wallTimeMs: AGENT_PROCESS_LIMITS.maxWallTimeMs + 1 }, { cpuTimeMs: 20_000 },
    { maxOutputBytes: AGENT_PROCESS_LIMITS.maxOutputBytes + 1 }, { maxMemoryMb: AGENT_PROCESS_LIMITS.maxMemoryMb + 1 },
    { maxProcesses: AGENT_PROCESS_LIMITS.maxProcesses + 1 }, { environment: { API_TOKEN: 'secret' } }
  ]) assert.equal((await validateAgentProcessIntent(request(patch), roots)).code, 'PROCESS_LIMIT_EXCEEDED');
  assert.equal((await validateAgentProcessIntent(request({ network: true }), roots)).code, 'PROCESS_NETWORK_NOT_ALLOWED');
});

test('output over-limit is discarded and a revoked process capability stops every registered process tree', async (t) => {
  const bounded = new AgentProcessOutputLimit(8);
  assert.equal(bounded.push(Buffer.from('12345678')), true);
  assert.equal(bounded.push(Buffer.from('overflow')), false);
  assert.equal(bounded.overflowed, true); assert.equal(bounded.result().byteLength, 0);

  const { root } = await scratch(t), project = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'a3.project.json'), 'utf8'));
  const broker = createProjectCapabilityBroker({ stateDirectory: join(resolve(root, '..'), 'process-profile-host'), authenticatedActor: { kind: 'agent', id: 'agent-1' },
    confirmUserAction: ({ operation }) => operation.startsWith('policy.') });
  await broker.setProfile({ root, projectId: project.projectId, profile: 'trabajar' });
  const registry = new ActiveAgentProcessRegistry(broker); let stops = 0;
  registry.track(id(977), project.projectId, () => { stops++; });
  assert.equal(registry.size, 1);
  assert.equal(await broker.revoke({ root, projectId: project.projectId, capability: 'process.run' }), true);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(stops, 1); assert.equal(registry.size, 0);
  registry.close();
});

test('deadline and cancellation abort a pending process and request whole-tree termination', async () => {
  let stops = 0;
  const deadline = createAgentProcessDeadline(10, () => { stops++; });
  await new Promise((resolvePromise) => deadline.signal.addEventListener('abort', resolvePromise, { once: true }));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(deadline.timedOut, true); assert.equal(stops, 1);
  deadline.dispose();
  const cancelled = createAgentProcessDeadline(10_000, () => { stops++; });
  cancelled.cancel();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(cancelled.signal.aborted, true); assert.equal(cancelled.timedOut, false); assert.equal(stops, 2);
  cancelled.dispose();
});

test('process requests still fail closed before validation can create a child because E0-C2 isolation is unproven', windows, async (t) => {
  const { root } = await scratch(t), project = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'a3.project.json'), 'utf8'));
  const actor = { kind: 'agent', id: 'agent-1' };
  const broker = createProjectCapabilityBroker({ stateDirectory: join(resolve(root, '..'), 'process-disabled-host'), authenticatedActor: actor,
    confirmUserAction: ({ operation }) => operation.startsWith('policy.') });
  await broker.setProfile({ root, projectId: project.projectId, profile: 'trabajar' });
  const approved = await captureAgentExecutionRoot('workspace', root);
  const result = await authorizeAgentProcess({ broker, root, projectId: project.projectId, actor, roots: [approved], intent: request() });
  assert.equal(AGENT_PROCESS_ISOLATION_AVAILABLE, false);
  assert.equal(result.ok, false); assert.equal(result.code, 'capability-unavailable'); assert.equal(result.missingCapability, 'process.run');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexTurnCoordinator, CodexTurnHost } from '../src/main/codex-turns.ts';
import { digest } from '../src/main/codex-turn-state.ts';

const binding = { projectId: '00000000-0000-4000-8000-000000000001', rootIdentity: 'a'.repeat(64) };
const fixtures = JSON.parse(await readFile(new URL('./fixtures/codex-turns/events.json', import.meta.url), 'utf8'));
const envelope = (sequence, message, connectionId) => ({ type: 'notification', connectionId, sequence, message });
const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; };
const request = (operationId = randomUUID()) => ({ ...binding, operationId, actor: { kind: 'agent', id: 'a3-fixture-agent' }, command: 'a3.core.update-entity', expectedRevisions: [], scope: {}, payload: { title: 'Revisado' } });

class FakeTransport {
  calls = []; listeners = new Set(); starts = 0; stops = 0;
  async start() { this.starts++; }
  async stop() { this.stops++; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async request(command) {
    this.calls.push(command);
    return command.method === 'thread/resume' ? { thread: { id: 'thread_fixture', sessionId: 'session_provider_fixture' } } : {};
  }
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'a3-turn-recovery-'));
  const transport = options.transport ?? new FakeTransport();
  let coordinator = await CodexTurnCoordinator.open(root, binding, { transport, ...options });
  const sessionId = await coordinator.addSession('thread_fixture', 'session_provider_fixture');
  const turnId = await coordinator.trackTurn(sessionId, 'turn_fixture', randomUUID());
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  return { root, transport, sessionId, turnId, get coordinator() { return coordinator; }, async restart() {
    await coordinator.close();
    coordinator = await CodexTurnCoordinator.open(root, binding, { transport });
    return coordinator;
  } };
}

/** Test-only durable effect+receipt in one synced file; not a production E5-D tool implementation. */
function executor(root, options = {}) {
  const path = join(root, 'fixture-effect-and-receipt.json');
  const bridge = {
    executions: 0,
    async authorize() { return options.allowed !== false; },
    async execute(context, input, signal) {
      bridge.executions++;
      if (options.before) await options.before(signal);
      const receipt = { projectId: context.projectId, operationId: input.operationId, requestHash: digest(input), resultHash: digest({ effect: 'one revision' }), revisions: [{ id: binding.projectId, revision: 2 }] };
      const file = await open(path, 'w');
      try { await file.writeFile(JSON.stringify({ effects: bridge.executions, receipt })); await file.sync(); } finally { await file.close(); }
      if (options.after) await options.after(signal);
      return receipt;
    },
    async lookup(context, operation) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value.receipt.projectId === context.projectId && value.receipt.operationId === operation.id ? value.receipt : null;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  };
  return bridge;
}

test('same delivery and stable final item IDs are idempotent; repeated text chunks remain legitimate', async (t) => {
  const ctx = await setup(t), connection = randomUUID();
  const delta = fixtures[1];
  await ctx.coordinator.ingest(envelope(1, delta, connection));
  await ctx.coordinator.ingest(envelope(1, delta, connection));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo');
  await ctx.coordinator.ingest(envelope(2, delta, connection));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'ListoListo');
  await ctx.coordinator.ingest(envelope(3, fixtures[2], connection));
  await ctx.coordinator.ingest(envelope(4, fixtures[2], connection));
  assert.deepEqual(ctx.coordinator.snapshot().transcript.map((item) => [item.text, item.confirmed]), [['Listo.', true]]);
  await ctx.restart();
  await ctx.coordinator.ingest(envelope(4, fixtures[2], connection));
  assert.equal(ctx.coordinator.snapshot().transcript.length, 1);
});

test('confirmed operation is returned without another effect across repeated restarts and actor/payload reuse is rejected', async (t) => {
  const ctx = await setup(t), bridge = executor(ctx.root), command = request();
  const receipt = await ctx.coordinator.runOperation(ctx.turnId, command, bridge);
  for (let n = 0; n < 2; n++) {
    await ctx.restart();
    assert.deepEqual(await ctx.coordinator.runOperation(ctx.turnId, command, bridge), receipt);
  }
  assert.equal(bridge.executions, 1);
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, { ...command, actor: { kind: 'agent', id: 'another-agent' } }, bridge), { code: 'OPERATION_ID_REUSED' });
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, { ...command, payload: { title: 'Otro' } }, bridge), { code: 'OPERATION_ID_REUSED' });
});

for (const phase of ['prepared', 'running', 'effect', 'confirmed']) {
  test(`interruption at ${phase}: restart never redispatches an uncertain or confirmed tool`, async (t) => {
    const ctx = await setup(t, { fault: async (current) => { if (current === phase) throw new Error('injected interruption'); } });
    const bridge = executor(ctx.root), command = request();
    await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, command, bridge));
    const before = bridge.executions;
    await ctx.restart();
    const receipt = await ctx.coordinator.reconcileOperation(command.operationId, bridge);
    assert.equal(!!receipt, ['effect', 'confirmed'].includes(phase));
    if (receipt) assert.deepEqual(await ctx.coordinator.runOperation(ctx.turnId, command, bridge), receipt);
    else await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, command, bridge));
    assert.equal(bridge.executions, before);
    assert.equal(before, ['effect', 'confirmed'].includes(phase) ? 1 : 0);
  });
}

test('interrupting inside executor reconciles its durable receipt without calling execute again', async (t) => {
  const ctx = await setup(t), command = request();
  const bridge = executor(ctx.root, { after: async () => { throw new Error('lost tool response after committed effect'); } });
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, command, bridge), { code: 'OPERATION_RESULT_UNCERTAIN' });
  await ctx.restart();
  assert.ok(await ctx.coordinator.reconcileOperation(command.operationId, bridge));
  await ctx.coordinator.runOperation(ctx.turnId, command, bridge);
  assert.equal(bridge.executions, 1);
});

test('cancel preserves committed transcript and acknowledges interruption only on terminal event', async (t) => {
  const ctx = await setup(t), connection = randomUUID(), bridge = executor(ctx.root), command = request();
  await ctx.coordinator.ingest(envelope(1, fixtures[2], connection));
  await ctx.coordinator.runOperation(ctx.turnId, command, bridge);
  await ctx.coordinator.cancel(ctx.turnId);
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'cancelling');
  assert.deepEqual(ctx.transport.calls[0], { method: 'turn/interrupt', params: { threadId: 'thread_fixture', turnId: 'turn_fixture' } });
  await ctx.coordinator.ingest(envelope(2, fixtures[3], connection));
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'interrupted');
  assert.equal(ctx.coordinator.snapshot().operations[0].status, 'confirmed');
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
  await ctx.restart();
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'interrupted');
});

test('cancel during tool dispatch preserves a late confirmed effect even if executor ignores abort', async (t) => {
  const ctx = await setup(t), entered = deferred(), resume = deferred();
  const bridge = executor(ctx.root, { before: async () => { entered.resolve(); await resume.promise; } });
  const pending = ctx.coordinator.runOperation(ctx.turnId, request(), bridge);
  await entered.promise;
  await ctx.coordinator.cancel(ctx.turnId);
  assert.equal(ctx.coordinator.snapshot().operations[0].status, 'uncertain');
  resume.resolve(); await pending;
  assert.equal(ctx.coordinator.snapshot().operations[0].status, 'confirmed');
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'cancelling');
});

test('gap, conflicting duplicate and malformed stream preserve confirmed transcript', async (t) => {
  const ctx = await setup(t), connection = randomUUID();
  await ctx.coordinator.ingest(envelope(1, fixtures[2], connection));
  await ctx.coordinator.ingest(envelope(3, fixtures[1], connection));
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'uncertain');
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
  const next = randomUUID();
  await ctx.coordinator.ingest(envelope(1, fixtures[2], next));
  await ctx.coordinator.ingest(envelope(1, fixtures[1], next));
  assert.ok(ctx.coordinator.snapshot().diagnostics.includes('DELIVERY_ID_REUSED'));
  await ctx.coordinator.ingest(envelope(1, { method: 'item/agentMessage/delta', params: { ...fixtures[1].params, delta: 42 } }, randomUUID()));
  assert.ok(ctx.coordinator.snapshot().diagnostics.includes('MALFORMED_PROVIDER_EVENT'));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
});

test('truncated journal opens its valid prefix read-only without changing original bytes', async (t) => {
  const ctx = await setup(t);
  await ctx.coordinator.ingest(envelope(1, fixtures[2], randomUUID()));
  const path = ctx.coordinator.journal.path;
  await ctx.coordinator.close();
  await appendFile(path, '{"version":1,"sequence":');
  const original = await readFile(path);
  await ctx.restart();
  assert.equal(ctx.coordinator.readOnly, true);
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
  assert.ok(ctx.coordinator.snapshot().diagnostics.includes('LOCAL_JOURNAL_CORRUPT'));
  await assert.rejects(ctx.coordinator.trackTurn(ctx.sessionId, 'another_turn', randomUUID()));
  assert.deepEqual(await readFile(path), original);
});

test('reconnect uses official resume request and marks missing notification replay uncertain', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.transport.starts, 0);
  await ctx.coordinator.ingest(envelope(1, fixtures[2], randomUUID()));
  await ctx.restart();
  await ctx.coordinator.reconnect(ctx.sessionId);
  assert.deepEqual(ctx.transport.calls, [{ method: 'thread/resume', params: { threadId: 'thread_fixture', excludeTurns: true } }]);
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'uncertain');
  assert.ok(ctx.coordinator.snapshot().diagnostics.includes('STDIO_REPLAY_UNAVAILABLE'));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
});

test('denied and cross-project operations never dispatch or create a receipt', async (t) => {
  const ctx = await setup(t), bridge = executor(ctx.root, { allowed: false });
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, request(), bridge), { code: 'PERMISSION_DENIED' });
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, { ...request(), projectId: randomUUID() }, bridge), { code: 'INVALID_OPERATION' });
  assert.equal(bridge.executions, 0); assert.equal(ctx.coordinator.snapshot().operations.length, 0);
});

test('host switches root bindings without mixing transcripts or starting processes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'a3-turn-isolation-')), transports = [];
  const host = new CodexTurnHost(root, () => { const port = new FakeTransport(); transports.push(port); return port; });
  t.after(async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }); });
  const first = await host.openProject(binding);
  const session = await first.addSession('thread_fixture', 'session_provider_fixture');
  await first.trackTurn(session, 'turn_fixture', randomUUID());
  await first.ingest(envelope(1, fixtures[2], randomUUID()));
  const second = await host.openProject({ ...binding, rootIdentity: 'b'.repeat(64) });
  assert.equal(second.snapshot().transcript.length, 0);
  const restored = await host.openProject(binding);
  assert.equal(restored.snapshot().transcript[0].text, 'Listo.');
  assert.ok(transports.every((transport) => transport.starts === 0));
});

test('concurrent identical tool requests coalesce into one effect', async (t) => {
  const ctx = await setup(t), bridge = executor(ctx.root), command = request();
  const [first, second] = await Promise.all([ctx.coordinator.runOperation(ctx.turnId, command, bridge), ctx.coordinator.runOperation(ctx.turnId, command, bridge)]);
  assert.deepEqual(first, second); assert.equal(bridge.executions, 1);
});

test('existing project receipt is consulted before any tool dispatch even without a local operation entry', async (t) => {
  const ctx = await setup(t), bridge = executor(ctx.root), command = request();
  const priorReceipt = await bridge.execute(binding, command, new AbortController().signal);
  assert.deepEqual(await ctx.coordinator.runOperation(ctx.turnId, command, bridge), priorReceipt);
  assert.equal(bridge.executions, 1);
});

test('remote completion remains uncertain until a running effect is reconciled', async (t) => {
  const ctx = await setup(t), command = request();
  const bridge = executor(ctx.root, { after: async () => { throw new Error('response lost'); } });
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, command, bridge));
  const completed = { method: 'turn/completed', params: { threadId: 'thread_fixture', turn: { id: 'turn_fixture', status: 'completed' } } };
  await ctx.coordinator.ingest(envelope(1, completed, randomUUID()));
  assert.equal(ctx.coordinator.snapshot().turns[0].providerStatus, 'completed');
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'uncertain');
  await ctx.coordinator.reconcileOperation(command.operationId, bridge);
  assert.equal(ctx.coordinator.snapshot().turns[0].status, 'completed');
});

test('revocation during receipt lookup prevents the following dispatch', async (t) => {
  const ctx = await setup(t), bridge = executor(ctx.root);
  let checks = 0; bridge.authorize = async () => ++checks === 1;
  await assert.rejects(ctx.coordinator.runOperation(ctx.turnId, request(), bridge), { code: 'PERMISSION_DENIED' });
  assert.equal(bridge.executions, 0);
});

test('unsequenced replay after reconnect cannot append duplicate deltas to the saved provisional message', async (t) => {
  const ctx = await setup(t);
  await ctx.coordinator.ingest(envelope(1, fixtures[1], randomUUID()));
  await ctx.restart();
  const reconnected = randomUUID();
  await ctx.coordinator.ingest(envelope(1, fixtures[1], reconnected));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo');
  assert.equal(ctx.coordinator.snapshot().transcript[0].confirmed, false);
  await ctx.coordinator.ingest(envelope(2, fixtures[2], reconnected));
  assert.equal(ctx.coordinator.snapshot().transcript[0].text, 'Listo.');
  assert.equal(ctx.coordinator.snapshot().transcript[0].confirmed, true);
});

test('receipt reconciliation racing the live tool result confirms once without a false failure', async (t) => {
  const ctx = await setup(t), committed = deferred(), release = deferred(), command = request();
  const bridge = executor(ctx.root, { after: async () => { committed.resolve(); await release.promise; } });
  const running = ctx.coordinator.runOperation(ctx.turnId, command, bridge);
  await committed.promise;
  const receipt = await ctx.coordinator.reconcileOperation(command.operationId, bridge);
  release.resolve();
  assert.deepEqual(await running, receipt);
  assert.equal(bridge.executions, 1);
  assert.equal(ctx.coordinator.snapshot().operations[0].status, 'confirmed');
});

for (const phase of ['prepared', 'running', 'effect', 'confirmed']) {
  test(`actual process exit at ${phase} recovers in a new host without repeating effects`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'a3-turn-process-crash-'));
    let restored;
    t.after(async () => { await restored?.close(); await rm(root, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ['--experimental-strip-types', '--experimental-transform-types',
        fileURLToPath(new URL('./fixtures/codex-turns/crash-worker.mjs', import.meta.url)), root, phase], {
        shell: false, windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot }
      });
      const timeout = setTimeout(() => { worker.kill(); reject(new Error('Crash worker timed out')); }, 10000);
      worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
      worker.once('close', (code) => { clearTimeout(timeout); code === 91 ? resolve() : reject(new Error(`Unexpected crash fixture exit: ${code}`)); });
    });
    restored = await CodexTurnCoordinator.open(root, binding);
    assert.equal(restored.snapshot().turns[0].status, 'uncertain');
    const bridge = executor(root), command = request('00000000-0000-4000-8000-000000000004');
    const receipt = await restored.reconcileOperation(command.operationId, bridge);
    if (['effect', 'confirmed'].includes(phase)) {
      assert.ok(receipt);
      assert.deepEqual(await restored.runOperation(restored.snapshot().turns[0].id, command, bridge), receipt);
      assert.equal(JSON.parse(await readFile(join(root, 'fixture-effect-and-receipt.json'), 'utf8')).effects, 1);
    } else {
      assert.equal(receipt, null);
      await assert.rejects(restored.runOperation(restored.snapshot().turns[0].id, command, bridge));
    }
    assert.equal(bridge.executions, 0);
  });
}
